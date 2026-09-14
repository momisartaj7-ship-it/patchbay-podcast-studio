(() => {
  const socket = io();

  // ---- DOM ----
  const entryScreen = document.getElementById('entry-screen');
  const roomScreen = document.getElementById('room-screen');
  const endScreen = document.getElementById('end-screen');
  const recordingsScreen = document.getElementById('recordings-screen');

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
  const btnRecordingsHome = document.getElementById('btn-recordings-home');
  const btnRecordingsEnd = document.getElementById('btn-recordings-end');
  const btnViewRecordings = document.getElementById('btn-view-recordings');
  const btnBackHome = document.getElementById('btn-back-home');
  const btnLoadRecordings = document.getElementById('btn-load-recordings');
  const btnChangeRoom = document.getElementById('btn-change-room');
  const btnClosePlayer = document.getElementById('btn-close-player');
  const inputRecordingsRoom = document.getElementById('input-recordings-room');
  const recordingsRoomPicker = document.getElementById('recordings-room-picker');
  const recordingsContent = document.getElementById('recordings-content');
  const recordingsSubtitle = document.getElementById('recordings-subtitle');
  const libraryRoomLabel = document.getElementById('library-room-label');
  const recordingPlayer = document.getElementById('recording-player');
  const recordingVideo = document.getElementById('recording-video');
  const recordingTitle = document.getElementById('recording-title');
  const recordingDownload = document.getElementById('recording-download');

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
  let compositeCanvas = null;
  let compositeCtx = null;
  let compositeAnimationFrame = null;
  let audioContext = null;
  let audioDestination = null;
  let mixedAudioStream = null;
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
    localStorage.setItem('patchbay-last-room', myRoom);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 }},
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      alert('Camera and microphone access is required to enter the studio.');
      return;
    }

    videoLocal.srcObject = localStream;
    videoLocal.style.transform = 'scaleX(-1)';
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

  // ---- Recording ----
  // The host creates ONE podcast-style recording: both video feeds are rendered
  // side-by-side onto a canvas and the host + guest audio are mixed together.
  // This produces a single .webm episode instead of two separate participant files.
  btnRecord.addEventListener('click', () => {
    if (!isHost) return;
    socket.emit('recording-command', {
      room: myRoom,
      command: isRecording ? 'stop' : 'start'
    });
  });

  socket.on('recording-command', ({ command }) => {
    if (command === 'start') startPodcastRecording();
    if (command === 'stop') stopPodcastRecording();
  });

  function drawVideoCover(ctx, video, x, y, w, h, mirror = true) {
    if (!video || video.readyState < 2) {
      ctx.fillStyle = '#0D0F13';
      ctx.fillRect(x, y, w, h);
      return;
    }

    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;

    ctx.save();

    if (mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    }

    ctx.restore();
  }

  function drawPodcastFrame() {
    if (!compositeCtx || !compositeCanvas) return;
    const w = compositeCanvas.width;
    const h = compositeCanvas.height;
    const gap = 6;
    const tileW = (w - gap) / 2;

    compositeCtx.fillStyle = '#0D0F13';
    compositeCtx.fillRect(0, 0, w, h);

    drawVideoCover(compositeCtx, videoLocal, 0, 0, tileW, h, true);
    drawVideoCover(compositeCtx, videoRemote, tileW + gap, 0, tileW, h, true);

    // Podcast-style name plates.
    compositeCtx.fillStyle = 'rgba(20, 23, 28, 0.78)';
    compositeCtx.fillRect(24, h - 64, Math.min(300, tileW - 48), 40);
    compositeCtx.fillRect(tileW + gap + 24, h - 64, Math.min(300, tileW - 48), 40);

    compositeCtx.fillStyle = '#FFFFFF';
    compositeCtx.font = '600 18px Space Grotesk, sans-serif';
    compositeCtx.fillText(`${myName} (host)`, 40, h - 38);
    compositeCtx.fillText(`${peerName || 'Guest'}`, tileW + gap + 40, h - 38);

    compositeAnimationFrame = requestAnimationFrame(drawPodcastFrame);
  }

  function createMixedAudioStream() {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioDestination = audioContext.createMediaStreamDestination();

      const localSource = audioContext.createMediaStreamSource(
        new MediaStream(localStream.getAudioTracks())
      );
      localSource.connect(audioDestination);

      const remoteStream = videoRemote.srcObject;
      if (remoteStream?.getAudioTracks()?.length) {
        const remoteSource = audioContext.createMediaStreamSource(
          new MediaStream(remoteStream.getAudioTracks())
        );
        remoteSource.connect(audioDestination);
      }

      mixedAudioStream = audioDestination.stream;
      return mixedAudioStream;
    } catch (err) {
      console.warn('Audio mixing unavailable; recording local audio only.', err);
      return new MediaStream(localStream.getAudioTracks());
    }
  }

  function startPodcastRecording() {
    if (isRecording) return;

    // Only the host uploads the finished composite episode.
    if (!isHost) {
      isRecording = true;
      recIndicator.classList.remove('hidden');
      startTimer();
      return;
    }

    recordedChunks = [];
    compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = 1920;
    compositeCanvas.height = 1080;
    compositeCtx = compositeCanvas.getContext('2d');

    const canvasStream = compositeCanvas.captureStream(30);
    const audioStream = createMixedAudioStream();
    const finalStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioStream.getAudioTracks()
    ]);

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
   mediaRecorder = new MediaRecorder(finalStream, {
     mimeType,
     videoBitsPerSecond: 8_000_000,
     audioBitsPerSecond: 192_000
});

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = uploadPodcastRecording;
    mediaRecorder.start(1000);

    drawPodcastFrame();

    isRecording = true;
    recIndicator.classList.remove('hidden');
    btnRecord.classList.add('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Stop recording';
    startTimer();
  }

  function stopPodcastRecording() {
    if (!isRecording) return;

    if (isHost && mediaRecorder) {
      mediaRecorder.stop();
      if (compositeAnimationFrame) cancelAnimationFrame(compositeAnimationFrame);
      compositeAnimationFrame = null;
      audioContext?.close().catch(() => {});
      audioContext = null;
      audioDestination = null;
      mixedAudioStream = null;
    }

    isRecording = false;
    recIndicator.classList.add('hidden');
    btnRecord.classList.remove('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Start recording';
    stopTimer();
  }

  async function uploadPodcastRecording() {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const formData = new FormData();
    formData.append('room', myRoom);
    formData.append('participant', 'episode');
    formData.append('track', 'podcast');
    formData.append('recording', blob, `podcast-${Date.now()}.webm`);

    connectionStatus.textContent = 'uploading podcast recording…';
    try {
      const res = await fetch('/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Upload failed');
      connectionStatus.textContent = 'podcast recording uploaded';
    } catch (err) {
      connectionStatus.textContent = 'upload failed — recording is still in browser memory';
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

  // ---- Navigation / recordings library ----
  btnLeave.addEventListener('click', endSession);

  function showHome() {
    roomScreen.classList.add('hidden');
    recordingsScreen.classList.add('hidden');
    endScreen.classList.remove('hidden');
  }

  function showRecordings(room = '') {
    roomScreen.classList.add('hidden');
    endScreen.classList.add('hidden');
    recordingsScreen.classList.remove('hidden');
    recordingPlayer.classList.add('hidden');
    recordingsContent.classList.add('hidden');

    const savedRoom = room || localStorage.getItem('patchbay-last-room') || '';
    inputRecordingsRoom.value = savedRoom;
    if (savedRoom) {
      loadRecordings(savedRoom);
    } else {
      recordingsRoomPicker.classList.remove('hidden');
      inputRecordingsRoom.focus();
    }
  }

  async function endSession() {
    if (isRecording) stopPodcastRecording();

    // Remember the room so Recordings is available from the home screen.
    localStorage.setItem('patchbay-last-room', myRoom);

    localStream?.getTracks().forEach(t => t.stop());
    pc?.close();
    socket.disconnect();

    roomScreen.classList.add('hidden');
    recordingsScreen.classList.add('hidden');
    endScreen.classList.remove('hidden');

    // Give the upload a moment to complete.
    setTimeout(() => {
      if (myRoom) loadRecordings(myRoom, true);
    }, 1500);
  }

  async function loadRecordings(room, keepHome = false) {
    room = (room || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!room) {
      recordingsRoomPicker.classList.remove('hidden');
      recordingsContent.classList.add('hidden');
      return;
    }

    recordingsRoomPicker.classList.add('hidden');
    recordingsContent.classList.remove('hidden');
    libraryRoomLabel.textContent = `Room: ${room}`;
    recordingsSubtitle.textContent = `Podcast episodes saved for “${room}”.`;

    try {
      const res = await fetch(`/recordings-list/${encodeURIComponent(room)}`);
      const data = await res.json();
      filesList.innerHTML = '';

      if (!data.files.length) {
        filesList.innerHTML = '<li class="files-empty">No recordings found for this room yet.</li>';
        return;
      }

      // Prefer podcast recordings over any older participant recordings.
      const sorted = [...data.files].sort((a, b) => {
        const ap = a.name.includes('-podcast-') ? 0 : 1;
        const bp = b.name.includes('-podcast-') ? 0 : 1;
        return ap - bp || b.name.localeCompare(a.name);
      });

      sorted.forEach(f => {
        const li = document.createElement('li');
        li.className = 'recording-card';
        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
        const isPodcast = f.name.includes('-podcast-');
        const label = isPodcast ? 'Podcast episode' : f.name;
        li.innerHTML = `
          <div class="recording-card-icon">🎙️</div>
          <div class="recording-card-main">
            <strong>${label}</strong>
            <span>${sizeMb} MB</span>
          </div>
          <div class="recording-card-actions">
            <button class="btn btn-primary play-recording" type="button">▶ Watch</button>
            <a class="btn btn-secondary" href="/download-recording/${encodeURIComponent(room)}/${encodeURIComponent(f.name)}">Download</a>
          </div>
        `;
        li.querySelector('.play-recording').addEventListener('click', () => openRecording(f, room));
        filesList.appendChild(li);
      });
    } catch (err) {
      filesList.innerHTML = '<li class="files-empty">Could not load recordings list.</li>';
    }
  }

  function openRecording(file, room) {
    recordingTitle.textContent = file.name.includes('-podcast-')
      ? `Podcast episode · ${room}`
      : file.name;
    recordingVideo.src = file.url;
    recordingDownload.href = `/download-recording/${encodeURIComponent(room)}/${encodeURIComponent(file.name)}`;
    recordingPlayer.classList.remove('hidden');
    recordingVideo.play().catch(() => {});
  }

  function closeRecording() {
    recordingVideo.pause();
    recordingVideo.removeAttribute('src');
    recordingVideo.load();
    recordingPlayer.classList.add('hidden');
  }

  btnRecordingsHome.addEventListener('click', () => showRecordings());
  btnRecordingsEnd.addEventListener('click', () => showRecordings(myRoom));
  btnViewRecordings.addEventListener('click', () => showRecordings(myRoom));
  btnBackHome.addEventListener('click', showHome);
  btnLoadRecordings.addEventListener('click', () => loadRecordings(inputRecordingsRoom.value));
  btnChangeRoom.addEventListener('click', () => {
    recordingsContent.classList.add('hidden');
    recordingsRoomPicker.classList.remove('hidden');
    inputRecordingsRoom.focus();
  });
  btnClosePlayer.addEventListener('click', closeRecording);
  inputRecordingsRoom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRecordings(inputRecordingsRoom.value);
  });

  btnRestart.addEventListener('click', () => location.reload());
})();
