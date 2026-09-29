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
  let isRecording = false;
  let isUploading = false;
  let timerInterval = null;
  let timerSeconds = 0;
  let serverClockOffset = 0;   // server time minus this computer's time, in ms
  let clockSyncTimer = null;
  let libraryRefreshTimer = null;

  // Fetched from the server (see /ice-servers) so TURN credentials can be
  // configured via env vars without touching client code. Kicked off
  // immediately; setupPeerConnection() awaits it before creating the
  // RTCPeerConnection so it's always ready in time, however fast the other
  // participant joins.
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // used only if the fetch below fails
  const iceServersReady = (async () => {
    try {
      const res = await fetch('/ice-servers');
      const data = await res.json();
      if (data.iceServers?.length) iceServers = data.iceServers;
    } catch (err) {
      console.warn('Could not load ICE server config; falling back to STUN only.', err);
    }
  })();

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

  // Works out how far this computer's clock is from the server's. Recording
  // start times are compared in server time, so the two people's recordings
  // can be lined up even if their clocks disagree. The lowest-latency sample
  // is the most trustworthy one.
  async function syncClock(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const serverNow = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);
        socket.emit('time-sync', (value) => { clearTimeout(timer); resolve(value); });
      });
      const t1 = Date.now();
      if (serverNow != null) {
        const rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt, offset: serverNow - (t0 + rtt / 2) };
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    if (best) serverClockOffset = best.offset;
  }

  socket.on('joined', ({ isHost: hostFlag }) => {
    isHost = hostFlag;
    syncClock();
    clearInterval(clockSyncTimer);
    clockSyncTimer = setInterval(() => syncClock(3), 30000);
    btnRecord.style.display = isHost ? '' : 'none';
    connectionStatus.textContent = isHost ? 'waiting for guest…' : 'connected to host, waiting for video…';
  });

  socket.on('peer-joined', async ({ peerId: id, name }) => {
    peerId = id;
    peerName = name || 'Guest';
    labelRemoteName.textContent = peerName;
    tileRemoteEmpty.classList.add('hidden');
    connectionStatus.textContent = `connecting to ${peerName}…`;

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
    if (!isUploading) connectionStatus.textContent = 'guest disconnected';
    tileRemoteEmpty.classList.remove('hidden');
    videoRemote.srcObject = null;
    labelRemoteName.textContent = 'Waiting…';
    peerId = null;
  });

  async function setupPeerConnection() {
    await iceServersReady;
    pc = new RTCPeerConnection({ iceServers });
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
      if (isUploading) return; // don't hide upload progress behind call-status text
      if (pc.connectionState === 'connected') {
        connectionStatus.textContent = `connected with ${peerName}`;
      } else if (pc.connectionState === 'failed') {
        connectionStatus.textContent = 'connection failed — check your network and try rejoining';
      } else if (pc.connectionState === 'disconnected') {
        connectionStatus.textContent = 'connection interrupted — reconnecting…';
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
  // Every participant records THEIR OWN camera and microphone on their own
  // computer, so the recording never depends on how good the call was. When the
  // host stops, each browser uploads its file and the server combines the two
  // into one side-by-side podcast episode.
  btnRecord.addEventListener('click', () => {
    if (!isHost) return;
    socket.emit('recording-command', { command: isRecording ? 'stop' : 'start' });
  });

  socket.on('recording-command', ({ command, sessionId }) => {
    if (command === 'start') startLocalRecording(sessionId);
    if (command === 'stop') stopLocalRecording();
  });

  function pickMimeType() {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  function startLocalRecording(sessionId) {
    if (isRecording || !localStream) return;

    // Remember everything the upload needs NOW: if the person leaves the
    // studio mid-recording, the socket (and its id) is gone by upload time.
    const recording = {
      sessionId,
      participantId: socket.id,
      chunks: [],
      startedAt: 0, // in server time
    };

    const mimeType = pickMimeType();
    try {
      mediaRecorder = new MediaRecorder(localStream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 160_000,
      });
    } catch (err) {
      console.error('Could not start MediaRecorder:', err);
      connectionStatus.textContent = 'could not start recording on this device';
      return;
    }

    const recorder = mediaRecorder;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) recording.chunks.push(e.data); };
    recorder.onstart = () => { recording.startedAt = Math.round(Date.now() + serverClockOffset); };
    recorder.onstop = () => uploadLocalRecording(recording, recorder.mimeType || mimeType);
    recorder.start(1000);

    isRecording = true;
    recIndicator.classList.remove('hidden');
    btnRecord.classList.add('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Stop recording';
    startTimer();
  }

  function stopLocalRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();

    recIndicator.classList.add('hidden');
    btnRecord.classList.remove('is-recording');
    btnRecord.innerHTML = '<span class="rec-btn-dot"></span> Start recording';
    stopTimer();
  }

  // Last-resort safety net: hand the recording to the user's own disk so a
  // failed upload never means a lost episode.
  function saveBlobLocally(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function uploadLocalRecording(recording, mimeType) {
    const blob = new Blob(recording.chunks, { type: mimeType || 'video/webm' });
    recording.chunks = [];
    if (!blob.size) {
      connectionStatus.textContent = 'nothing was recorded';
      return;
    }

    const ext = /mp4/.test(mimeType || '') ? 'mp4' : 'webm';
    const room = myRoom;
    const safeName = (myName || 'recording').replace(/[^a-zA-Z0-9-_]/g, '') || 'recording';
    const backupName = `${safeName}-${recording.sessionId || Date.now()}.${ext}`;

    isUploading = true;
    connectionStatus.textContent = 'uploading your recording… 0%';
    let uploaded = false;
    try {
      await PatchbayUploader.uploadRecording(
        blob,
        {
          room,
          sessionId: recording.sessionId,
          participantId: recording.participantId,
          participant: myName,
          startedAt: recording.startedAt,
          ext,
        },
        {
          onProgress: (pct) => { connectionStatus.textContent = `uploading your recording… ${pct}%`; },
          onRetry: (attempt) => { connectionStatus.textContent = `connection is slow — retrying (${attempt})…`; },
        }
      );
      uploaded = true;
    } catch (err) {
      console.warn('Upload failed:', err);
    }
    isUploading = false;

    if (!uploaded) {
      saveBlobLocally(blob, backupName);
      connectionStatus.textContent = 'upload failed — a copy was saved to your Downloads folder';
      return;
    }
    connectionStatus.textContent = 'your recording is uploaded';
    followEpisode(room, recording.sessionId);
  }

  // After uploading, keep the status line updated while the server waits for
  // the other person and then builds the combined episode.
  const EPISODE_MESSAGES = {
    uploading: "waiting for the other person's upload…",
    processing: 'building your podcast episode…',
    ready: 'episode ready — open Recordings to watch it',
    failed: 'could not combine the recordings — each person\'s own file is saved',
    incomplete: "the other person's recording never arrived — your own file is saved",
    saved: 'recording saved',
  };
  const EPISODE_DONE = ['ready', 'failed', 'incomplete', 'saved'];

  async function followEpisode(room, sessionId) {
    for (let i = 0; i < 300; i++) { // about 20 minutes
      try {
        const res = await fetch(`/episode-status/${encodeURIComponent(room)}`);
        const data = await res.json();
        const entry = data.sessions.find((x) => x.sessionId === sessionId);
        if (entry) {
          if (!isUploading && !isRecording && EPISODE_MESSAGES[entry.status]) {
            connectionStatus.textContent = EPISODE_MESSAGES[entry.status];
          }
          if (EPISODE_DONE.includes(entry.status)) return;
        }
      } catch (err) { /* keep trying */ }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // Closing the tab mid-upload would lose the recording; ask first.
  window.addEventListener('beforeunload', (e) => {
    if (isUploading) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

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
    if (isRecording) stopLocalRecording();
    clearInterval(clockSyncTimer);

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

  const LIBRARY_BANNERS = {
    recording: '🔴 A recording is in progress in this room.',
    uploading: '⏳ Recordings are still uploading — your episode will appear here shortly.',
    processing: '⏳ Building your podcast episode — this can take a few minutes. This list updates by itself.',
  };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // File names end in the moment the recording started (e.g. ...-1790619821932.mp4).
  function fileTimestamp(name) {
    const m = /-(\d{12,})\.(webm|mp4)$/.exec(name);
    return m ? Number(m[1]) : 0;
  }

  function describeFile(name) {
    const when = fileTimestamp(name);
    const date = when ? new Date(when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    if (name.includes('-podcast-')) return date ? `Podcast episode · ${date}` : 'Podcast episode';
    const m = /^(.+)-(host|guest|solo)-\d+\.(webm|mp4)$/.exec(name);
    if (m) {
      const who = m[2] === 'solo' ? `${m[1]} (solo recording)` : `${m[1]} — own recording`;
      return date ? `${who} · ${date}` : who;
    }
    return name;
  }

  async function loadRecordings(room, keepHome = false) {
    clearTimeout(libraryRefreshTimer);
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

      // Is an episode still being recorded, uploaded or built for this room?
      let banner = '';
      try {
        const statusRes = await fetch(`/episode-status/${encodeURIComponent(room)}`);
        const status = await statusRes.json();
        const active = status.sessions.find((x) => LIBRARY_BANNERS[x.status]);
        if (active) banner = LIBRARY_BANNERS[active.status];
      } catch (err) { /* the list still works without it */ }

      filesList.innerHTML = '';
      if (banner) {
        const li = document.createElement('li');
        li.className = 'files-empty';
        li.textContent = banner;
        filesList.appendChild(li);
        // Check again shortly, as long as someone is looking at the recordings.
        const looking = !recordingsScreen.classList.contains('hidden') || !endScreen.classList.contains('hidden');
        if (looking) libraryRefreshTimer = setTimeout(() => loadRecordings(room, keepHome), 6000);
      }

      if (!data.files.length) {
        if (!banner) filesList.innerHTML = '<li class="files-empty">No recordings found for this room yet.</li>';
        return;
      }

      // Episodes first, then everyone's own files; newest first within each.
      const sorted = [...data.files].sort((a, b) => {
        const ap = a.name.includes('-podcast-') ? 0 : 1;
        const bp = b.name.includes('-podcast-') ? 0 : 1;
        return ap - bp || fileTimestamp(b.name) - fileTimestamp(a.name) || b.name.localeCompare(a.name);
      });

      sorted.forEach(f => {
        const li = document.createElement('li');
        li.className = 'recording-card';
        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
        li.innerHTML = `
          <div class="recording-card-icon">🎙️</div>
          <div class="recording-card-main">
            <strong>${escapeHtml(describeFile(f.name))}</strong>
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
    recordingTitle.textContent = `${describeFile(file.name)} · ${room}`;
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
