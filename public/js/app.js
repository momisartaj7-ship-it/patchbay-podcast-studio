(() => {
  const socket = io();

  // ---- DOM ----
  const entryScreen = document.getElementById('entry-screen');
  const roomScreen = document.getElementById('room-screen');
  const endScreen = document.getElementById('end-screen');

  const inputName = document.getElementById('input-name');
  const inputRoom = document.getElementById('input-room');
  const btnJoin = document.getElementById('btn-join');

  const displayRoom = document.getElementById('display-room');
  const roomCodeBig = document.getElementById('room-code-big');
  const connectionStatus = document.getElementById('connection-status');
  const sessionTimer = document.getElementById('session-timer');
  const recIndicator = document.getElementById('rec-indicator');

  const videoLocal = document.getElementById('video-local');
  const videoRemote = document.getElementById('video-remote');
  const labelLocalName = document.getElementById('label-local-name');
  const labelRemoteName = document.getElementById('label-remote-name');
  const tileRemoteEmpty = document.getElementById('tile-remote-empty');

  const btnMic = document.getElementById('btn-mic');
  const btnCam = document.getElementById('btn-cam');
  const btnRecord = document.getElementById('btn-record');
  const btnLeave = document.getElementById('btn-leave');

  const filesList = document.getElementById('files-list');
  const btnRestart = document.getElementById('btn-restart');

  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnCopyLinkTile = document.getElementById('btn-copy-link-tile');

  // ---- State ----
  let myName = '';
  let myRoom = '';
  let isHost = false;
  let peerId = null;
  let peerName = 'Guest';
  let localStream = null;
  let pc = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let timerInterval = null;
  let timerSeconds = 0;
  let expectedUploads = 0;
  let receivedUploads = 0;

  const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  // ---- Entry flow ----
  btnJoin.addEventListener('click', joinStudio);
  inputRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinStudio(); });
  inputName.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinStudio(); });

  // If someone opened an invite link (?room=xxx), prefill and lock the room
  // field so they only have to type their name.
  (function prefillFromInviteLink() {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      inputRoom.value = roomParam;
      inputRoom.readOnly = true;
      inputName.focus();
    }
  })();

  function buildInviteLink(room) {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', room);
    return url.toString();
  }

  async function copyInviteLink(button) {
    const link = buildInviteLink(myRoom);
    const originalLabel = button.textContent;
    try {
      await navigator.clipboard.writeText(link);
      button.textContent = 'Link copied!';
    } catch (err) {
      // Clipboard API unavailable (e.g. insecure context) — fall back to a prompt.
      window.prompt('Copy this invite link:', link);
      button.textContent = 'Link ready';
    }
    button.classList.add('is-copied');
    setTimeout(() => {
      button.textContent = originalLabel;
      button.classList.remove('is-copied');
    }, 2000);
  }

  btnCopyLink.addEventListener('click', () => copyInviteLink(btnCopyLink));
  btnCopyLinkTile.addEventListener('click', () => copyInviteLink(btnCopyLinkTile));

  async function joinStudio() {
    const name = inputName.value.trim();
    const room = inputRoom.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name || !room) {
      alert('Enter your name and a room code to continue.');
      return;
    }
    myName = name;
    myRoom = room;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      alert('Camera and microphone access is required to enter the studio.');
      return;
    }

    videoLocal.srcObject = localStream;
    labelLocalName.textContent = `${myName} (you)`;
    displayRoom.textContent = myRoom;
    roomCodeBig.textContent = buildInviteLink(myRoom);

    entryScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');

    socket.emit('join-room', { room: myRoom, name: myName });
  }

  // ---- Signaling events ----
  socket.on('room-full', () => {
    alert('This room already has two participants. Try a different room code.');
    location.reload();
  });

  socket.on('joined', ({ isHost: hostFlag }) => {
    isHost = hostFlag;
    btnRecord.style.display = isHost ? '' : 'none';
    connectionStatus.textContent = isHost ? 'waiting for guest…' : 'connected to host, waiting for video…';
  });

  socket.on('peer-joined', async ({ peerId: id, name }) => {
    peerId = id;
    peerName = name || 'Guest';
    labelRemoteName.textContent = peerName;
    tileRemoteEmpty.classList.add('hidden');
    connectionStatus.textContent = `connected with ${peerName}`;

    // The participant with the lexicographically smaller socket id initiates the offer,
    // avoiding a double-offer race between the two peers.
    if (socket.id < id) {
      await setupPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { type: 'offer', sdp: offer } });
    } else {
      await setupPeerConnection();
    }
  });

  socket.on('signal', async ({ from, data }) => {
    if (!pc) await setupPeerConnection();
    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice') {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { /* ignore benign race */ }
    }
  });

  socket.on('peer-left', () => {
    connectionStatus.textContent = 'guest disconnected';
    tileRemoteEmpty.classList.remove('hidden');
    videoRemote.srcObject = null;
    labelRemoteName.textContent = 'Waiting…';
    peerId = null;
  });

  async function setupPeerConnection() {
    pc = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate && peerId) {
        socket.emit('signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      videoRemote.srcObject = e.streams[0];
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        connectionStatus.textContent = `connected with ${peerName}`;
      }
    };
  }

  // ---- Mic / camera toggles ----
  btnMic.addEventListener('click', () => {
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    btnMic.setAttribute('aria-pressed', String(track.enabled));
    btnMic.title = track.enabled ? 'Mute microphone' : 'Unmute microphone';
  });

  btnCam.addEventListener('click', () => {
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    btnCam.setAttribute('aria-pressed', String(track.enabled));
    btnCam.title = track.enabled ? 'Turn off camera' : 'Turn on camera';
  });

  // ---- Recording (local, HD, per-participant) ----
  // The host's "Start recording" click is relayed through the server so every
  // participant's browser starts capturing its own local stream at the same moment.
  btnRecord.addEventListener('click', () => {
    if (!isHost) return;
    socket.emit('recording-command', {
      room: myRoom,
      command: isRecording ? 'stop' : 'start'
    });
  });

  socket.on('recording-command', ({ command }) => {
    if (command === 'start') startLocalRecording();
    if (command === 'stop') stopLocalRecording();
  });

  function startLocalRecording() {
    if (isRecording) return;
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    mediaRecorder = new MediaRecorder(localStream, { mimeType, videoBitsPerSecond: 4_000_000 });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = uploadRecording;
    mediaRecorder.start(1000);

    isRecording = true;
    recIndicator.classList.remove('hidden');
    btnRecord.classList.add('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Stop recording';
    startTimer();
  }

  function stopLocalRecording() {
    if (!isRecording || !mediaRecorder) return;
    mediaRecorder.stop();
    isRecording = false;
    recIndicator.classList.add('hidden');
    btnRecord.classList.remove('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Start recording';
    stopTimer();
  }

  async function uploadRecording() {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const formData = new FormData();
    formData.append('room', myRoom);
    formData.append('participant', myName);
    formData.append('track', 'av');
    formData.append('recording', blob, `${myName}.webm`);

    connectionStatus.textContent = 'uploading your recording…';
    try {
      await fetch('/upload', { method: 'POST', body: formData });
      connectionStatus.textContent = 'recording uploaded';
    } catch (err) {
      connectionStatus.textContent = 'upload failed — recording kept in browser memory only';
    }
  }

  // ---- Timer ----
  function startTimer() {
    timerSeconds = 0;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      timerSeconds += 1;
      updateTimerDisplay();
    }, 1000);
  }
  function stopTimer() {
    clearInterval(timerInterval);
  }
  function updateTimerDisplay() {
    const h = String(Math.floor(timerSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((timerSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(timerSeconds % 60).padStart(2, '0');
    sessionTimer.textContent = `${h}:${m}:${s}`;
  }

  // ---- Leave / end session ----
  btnLeave.addEventListener('click', endSession);

  async function endSession() {
    if (isRecording) stopLocalRecording();
    localStream?.getTracks().forEach(t => t.stop());
    pc?.close();
    socket.disconnect();

    roomScreen.classList.add('hidden');
    endScreen.classList.remove('hidden');

    // Give the upload a moment to complete, then show what's on the server for this room.
    setTimeout(loadFilesList, 1500);
  }

  async function loadFilesList() {
    try {
      const res = await fetch(`/recordings-list/${myRoom}`);
      const data = await res.json();
      filesList.innerHTML = '';
      if (!data.files.length) {
        filesList.innerHTML = '<li class="files-empty">No recordings uploaded yet — check back in a moment.</li>';
        return;
      }
      data.files.forEach(f => {
        const li = document.createElement('li');
        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
        li.innerHTML = `<span>${f.name} <span style="color:var(--text-muted)">(${sizeMb} MB)</span></span><a href="${f.url}" download>Download</a>`;
        filesList.appendChild(li);
      });
    } catch (err) {
      filesList.innerHTML = '<li class="files-empty">Could not load recordings list.</li>';
    }
  }

  btnRestart.addEventListener('click', () => location.reload());
})();
