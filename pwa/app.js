(() => {
  'use strict';

  const SETTINGS_KEY    = 'photoUpload.settings.v1';
  const MODE_KEY        = 'photoUpload.mode.v1';
  const CONFIG_HASH_KEY = 'photoUpload.configHash.v1';
  const FLUSH_INTERVAL_MS = 25000;
  const SYNC_TAG = 'flush-photo-queue';

  // ---------- Elements ----------
  const settingsScreen     = document.getElementById('settingsScreen');
  const captureScreen      = document.getElementById('captureScreen');
  const settingsForm       = document.getElementById('settingsForm');
  const serverUrlInput     = document.getElementById('serverUrl');
  const apiKeyInput        = document.getElementById('apiKey');
  const employeeIdInput    = document.getElementById('employeeId');
  const toggleKeyVisibility= document.getElementById('toggleKeyVisibility');
  const testConnectionBtn  = document.getElementById('testConnectionBtn');
  const testResult         = document.getElementById('testResult');
  const openSettingsBtn    = document.getElementById('openSettingsBtn');
  const employeeBadge      = document.getElementById('employeeBadge');
  const pendingPill        = document.getElementById('pendingPill');

  const modeSingleBtn      = document.getElementById('modeSingle');
  const modeBatchBtn       = document.getElementById('modeBatch');

  const preview            = document.getElementById('preview');
  const previewImg         = document.getElementById('previewImg');
  const cameraInput        = document.getElementById('cameraInput');
  const libraryInput       = document.getElementById('libraryInput');
  const shutterBtn         = document.getElementById('shutterBtn');
  const galleryBtn         = document.getElementById('galleryBtn');
  const preCaptureActions  = document.getElementById('preCaptureActions');

  // Single-photo confirm
  const postCaptureActions = document.getElementById('postCaptureActions');
  const retakeBtn          = document.getElementById('retakeBtn');
  const uploadBtn          = document.getElementById('uploadBtn');

  // Batch confirm (per-shot)
  const batchCaptureActions= document.getElementById('batchCaptureActions');
  const batchDiscardBtn    = document.getElementById('batchDiscardBtn');
  const batchAddBtn        = document.getElementById('batchAddBtn');

  // Batch strip
  const batchStrip         = document.getElementById('batchStrip');
  const batchCount         = document.getElementById('batchCount');
  const batchThumbRow      = document.getElementById('batchThumbRow');
  const clearBatchBtn      = document.getElementById('clearBatchBtn');
  const createPdfBtn       = document.getElementById('createPdfBtn');
  const pdfProgressWrap    = document.getElementById('pdfProgressWrap');
  const pdfProgressBar     = document.getElementById('pdfProgressBar');
  const pdfProgressLabel   = document.getElementById('pdfProgressLabel');

  const statusMsg          = document.getElementById('statusMsg');
  const offlineBanner      = document.getElementById('offlineBanner');
  const installBtn         = document.getElementById('installBtn');
  const queueList          = document.getElementById('queueList');
  const queueCount         = document.getElementById('queueCount');
  const queueEmpty         = document.getElementById('queueEmpty');
  const retryAllBtn        = document.getElementById('retryAllBtn');

  // ---------- State ----------
  let currentFile      = null;       // file waiting for single confirm
  let currentPreviewUrl= null;
  let batchPhotos      = [];         // [{ blob, previewUrl }] for PDF batch
  let isBatchMode      = false;
  let swRegistration   = null;
  const queueThumbUrls = new Map();

  // Crop modal
  const cropModal      = document.getElementById('cropModal');
  const cropImg        = document.getElementById('cropImg');
  const cropCancelBtn  = document.getElementById('cropCancelBtn');
  const cropConfirmBtn = document.getElementById('cropConfirmBtn');
  const cropRotateCCWBtn = document.getElementById('cropRotateCCWBtn');
  const cropRotateCWBtn  = document.getElementById('cropRotateCWBtn');
  const cropFlipHBtn     = document.getElementById('cropFlipHBtn');
  const cropResetBtn     = document.getElementById('cropResetBtn');
  let cropperInstance  = null;
  let cropResolve      = null;   // resolves with cropped Blob or null (cancel)

  // ---------- Settings ----------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch { return {}; }
  }
  async function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    await pqSaveSettings(s);
  }
  function settingsComplete(s) {
    return Boolean(s.serverUrl && s.apiKey && s.employeeId);
  }
  function normalizeServerUrl(url) { return url.trim().replace(/\/+$/, ''); }

  // ---------- Mode ----------
  function setMode(batch) {
    isBatchMode = batch;
    localStorage.setItem(MODE_KEY, batch ? 'batch' : 'single');
    modeSingleBtn.classList.toggle('mode-btn--active', !batch);
    modeBatchBtn.classList.toggle('mode-btn--active', batch);
    resetCapture();
    if (!batch) clearBatch();
    updateBatchStrip();
  }
  modeSingleBtn.addEventListener('click', () => setMode(false));
  modeBatchBtn.addEventListener('click',  () => setMode(true));

  // ---------- Crop modal ----------
  // Returns a Promise<Blob|null>. Null means the user cancelled.
  let _cropObjectUrl = null;   // kept alive until closeCropper so Cropper.js can re-read it

  function openCropper(sourceBlob) {
    return new Promise(resolve => {
      cropResolve = resolve;

      if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
      if (_cropObjectUrl) { URL.revokeObjectURL(_cropObjectUrl); _cropObjectUrl = null; }

      // Reset ratio buttons
      document.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.remove('crop-ratio-btn--active'));
      document.getElementById('cropFreeBtn').classList.add('crop-ratio-btn--active');

      _cropObjectUrl = URL.createObjectURL(sourceBlob);
      cropImg.src = _cropObjectUrl;
      cropModal.classList.remove('crop-modal--hidden');

      // Initialise Cropper.js via its own 'ready' event so we know the image
      // is fully decoded and the container has layout dimensions.
      cropperInstance = new Cropper(cropImg, {
        viewMode: 1,
        autoCropArea: 0.95,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
      });
    });
  }

  function closeCropper(result) {
    cropModal.classList.add('crop-modal--hidden');
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
    if (_cropObjectUrl) { URL.revokeObjectURL(_cropObjectUrl); _cropObjectUrl = null; }
    cropImg.src = '';
    if (cropResolve) { cropResolve(result); cropResolve = null; }
  }

  cropCancelBtn.addEventListener('click', () => closeCropper(null));

  cropConfirmBtn.addEventListener('click', () => {
    if (!cropperInstance) { closeCropper(null); return; }
    const canvas = cropperInstance.getCroppedCanvas({ maxWidth: 4096, maxHeight: 4096, fillColor: '#fff' });
    canvas.toBlob(blob => closeCropper(blob), 'image/jpeg', 0.92);
  });

  cropRotateCCWBtn.addEventListener('click', () => cropperInstance && cropperInstance.rotate(-90));
  cropRotateCWBtn.addEventListener('click',  () => cropperInstance && cropperInstance.rotate(90));
  cropFlipHBtn.addEventListener('click', () => {
    if (!cropperInstance) return;
    const d = cropperInstance.getData();
    cropperInstance.scaleX(-1 * (d.scaleX || 1));
  });
  cropResetBtn.addEventListener('click', () => cropperInstance && cropperInstance.reset());

  document.querySelectorAll('.crop-ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.remove('crop-ratio-btn--active'));
      btn.classList.add('crop-ratio-btn--active');
      const ratio = parseFloat(btn.dataset.ratio);
      cropperInstance && cropperInstance.setAspectRatio(isNaN(ratio) ? NaN : ratio);
    });
  });

  // ---------- Screen switching ----------
  function showSettingsScreen(prefill) {
    const s = prefill || loadSettings();
    serverUrlInput.value  = s.serverUrl  || '';
    apiKeyInput.value     = s.apiKey     || '';
    employeeIdInput.value = s.employeeId || '';
    testResult.textContent = '';
    testResult.className   = 'test-result';
    settingsScreen.classList.remove('screen--hidden');
    captureScreen.classList.add('screen--hidden');
  }
  function showCaptureScreen() {
    const s = loadSettings();
    employeeBadge.innerHTML = `<strong>${escapeHtml(s.employeeId)}</strong>`;
    settingsScreen.classList.add('screen--hidden');
    captureScreen.classList.remove('screen--hidden');
  }
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------- Init ----------
  async function init() {
    const s = loadSettings();
    if (settingsComplete(s)) {
      await pqSaveSettings(s);
      showCaptureScreen();
    } else {
      showSettingsScreen(s);
    }
    const savedMode = localStorage.getItem(MODE_KEY);
    setMode(savedMode === 'batch');

    if ('storage' in navigator && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    await renderQueue();
    attemptFlush();
  }

  // ---------- Settings form ----------
  toggleKeyVisibility.addEventListener('click', () => {
    const isPw = apiKeyInput.type === 'password';
    apiKeyInput.type = isPw ? 'text' : 'password';
    toggleKeyVisibility.textContent = isPw ? '🙈' : '👁';
    toggleKeyVisibility.setAttribute('aria-label', isPw ? 'Hide API key' : 'Show API key');
  });

  function currentFormSettings() {
    return {
      serverUrl:  normalizeServerUrl(serverUrlInput.value),
      apiKey:     apiKeyInput.value.trim(),
      employeeId: employeeIdInput.value.trim(),
    };
  }

  testConnectionBtn.addEventListener('click', async () => {
    const s = currentFormSettings();
    if (!s.serverUrl || !s.apiKey) {
      testResult.textContent = 'Enter a server URL and API key first.';
      testResult.className = 'test-result test-result--fail';
      return;
    }
    testResult.textContent = 'Testing…';
    testResult.className = 'test-result';
    try {
      const res = await fetch(`${s.serverUrl}/api/health`, {
        headers: { Authorization: `Bearer ${s.apiKey}` },
      });
      if (res.ok) {
        testResult.textContent = '✓ Connected successfully.';
        testResult.className = 'test-result test-result--ok';
      } else if (res.status === 401) {
        testResult.textContent = '✗ Server reachable, but the API key was rejected.';
        testResult.className = 'test-result test-result--fail';
      } else {
        testResult.textContent = `✗ Server responded with status ${res.status}.`;
        testResult.className = 'test-result test-result--fail';
      }
    } catch {
      testResult.textContent = '✗ Could not reach the server. Check the URL and your connection.';
      testResult.className = 'test-result test-result--fail';
    }
  });

  settingsForm.addEventListener('submit', async e => {
    e.preventDefault();
    const s = currentFormSettings();
    if (!s.serverUrl || !s.apiKey || !s.employeeId) {
      testResult.textContent = 'Server URL, API key, and employee identifier are required.';
      testResult.className = 'test-result test-result--fail';
      return;
    }
    await saveSettings(s);
    localStorage.removeItem(CONFIG_HASH_KEY);
    configChanged = false;
    updateBanner.classList.add('banner--hidden');
    showCaptureScreen();
    attemptFlush();
    checkConfigVersion(); // store the server's current hash baseline immediately
  });

  openSettingsBtn.addEventListener('click', () => showSettingsScreen());

  // ---------- Capture ----------
  shutterBtn.addEventListener('click', () => cameraInput.click());
  galleryBtn.addEventListener('click', () => libraryInput.click());
  cameraInput.addEventListener('change', e => handleFileSelected(e.target.files[0]));
  libraryInput.addEventListener('change', e => handleFileSelected(e.target.files[0]));

  function handleFileSelected(file) {
    if (!file) return;
    currentFile = file;
    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = URL.createObjectURL(file);
    previewImg.src = currentPreviewUrl;
    preview.classList.add('preview--has-photo');
    preCaptureActions.classList.add('actions--hidden');
    statusMsg.textContent = '';
    statusMsg.className   = 'status-msg';

    if (isBatchMode) {
      batchCaptureActions.classList.remove('actions--hidden');
      postCaptureActions.classList.add('actions--hidden');
    } else {
      postCaptureActions.classList.remove('actions--hidden');
      batchCaptureActions.classList.add('actions--hidden');
    }
  }

  function resetCapture() {
    currentFile = null;
    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
    previewImg.removeAttribute('src');
    preview.classList.remove('preview--has-photo');
    preCaptureActions.classList.remove('actions--hidden');
    postCaptureActions.classList.add('actions--hidden');
    batchCaptureActions.classList.add('actions--hidden');
    cameraInput.value  = '';
    libraryInput.value = '';
  }

  // ---------- Single-photo save ----------
  retakeBtn.addEventListener('click', resetCapture);

  uploadBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    const s = loadSettings();
    if (!settingsComplete(s)) { showSettingsScreen(s); return; }

    const croppedBlob = await openCropper(currentFile);
    if (!croppedBlob) return; // user cancelled crop

    uploadBtn.disabled = true;
    statusMsg.textContent = 'Building PDF…';
    statusMsg.className   = 'status-msg';

    try {
      const pdfBytes = await buildPdf([{ blob: croppedBlob, previewUrl: null }]);
      const pdfBlob  = new Blob([pdfBytes], { type: 'application/pdf' });
      const ts       = new Date().toISOString().replace(/[:.]/g, '-');
      const safe     = s.employeeId.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'employee';

      const record = {
        blob:       pdfBlob,
        mimeType:   'application/pdf',
        fileName:   `${safe}_${ts}.pdf`,
        employeeId: s.employeeId,
        capturedAt: new Date().toISOString(),
        pageCount:  1,
        status:     'queued',
        attempts:   0,
        lastError:  null,
        fileType:   'pdf',
      };

      await pqAdd(record);
      statusMsg.textContent = 'Photo saved as PDF on this device.';
      statusMsg.className   = 'status-msg status-msg--ok';
      resetCapture();
      await renderQueue();
      attemptFlush();
      registerBackgroundSync();
    } catch (err) {
      statusMsg.textContent = 'Failed to build PDF: ' + err.message;
      statusMsg.className   = 'status-msg status-msg--fail';
    } finally {
      uploadBtn.disabled = false;
    }
  });

  // ---------- Batch: add current shot ----------
  batchDiscardBtn.addEventListener('click', () => resetCapture());

  batchAddBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    const croppedBlob = await openCropper(currentFile);
    if (!croppedBlob) return; // user cancelled

    const thumbUrl = URL.createObjectURL(croppedBlob);
    batchPhotos.push({ blob: croppedBlob, previewUrl: thumbUrl });
    updateBatchStrip();
    resetCapture();
    statusMsg.textContent = `Photo ${batchPhotos.length} added to batch.`;
    statusMsg.className   = 'status-msg status-msg--ok';
  });

  // ---------- Batch strip ----------
  function updateBatchStrip() {
    const count = batchPhotos.length;
    batchStrip.classList.toggle('batch-strip--hidden', !isBatchMode || count === 0);
    batchCount.textContent = `${count} photo${count !== 1 ? 's' : ''}`;

    batchThumbRow.innerHTML = '';
    batchPhotos.forEach((p, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'batch-thumb';
      wrap.innerHTML = `
        <img src="${p.previewUrl}" alt="Photo ${i + 1}" />
        <span class="batch-thumb__num">${i + 1}</span>
        <button class="batch-thumb__remove" aria-label="Remove photo ${i + 1}">✕</button>
      `;
      wrap.querySelector('.batch-thumb__remove').addEventListener('click', () => {
        URL.revokeObjectURL(batchPhotos[i].previewUrl);
        batchPhotos.splice(i, 1);
        updateBatchStrip();
      });
      batchThumbRow.appendChild(wrap);
    });
  }

  function clearBatch() {
    batchPhotos.forEach(p => URL.revokeObjectURL(p.previewUrl));
    batchPhotos = [];
    updateBatchStrip();
  }

  clearBatchBtn.addEventListener('click', () => {
    if (batchPhotos.length === 0) return;
    if (confirm(`Discard all ${batchPhotos.length} photos in the batch?`)) clearBatch();
  });

  // ---------- Create PDF and queue ----------
  createPdfBtn.addEventListener('click', async () => {
    if (batchPhotos.length === 0) return;
    const s = loadSettings();
    if (!settingsComplete(s)) { showSettingsScreen(s); return; }

    createPdfBtn.disabled = true;
    pdfProgressWrap.classList.remove('pdf-progress-wrap--hidden');
    pdfProgressBar.style.width = '0%';
    pdfProgressLabel.textContent = 'Building PDF…';

    try {
      const pdfBytes = await buildPdf(batchPhotos, progress => {
        const pct = Math.round(progress * 100);
        pdfProgressBar.style.width = pct + '%';
        pdfProgressLabel.textContent = `Building PDF… ${pct}%`;
      });

      pdfProgressLabel.textContent = 'Done.';

      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      const ts      = new Date().toISOString().replace(/[:.]/g, '-');
      const safe    = s.employeeId.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'employee';
      const record  = {
        blob:       pdfBlob,
        mimeType:   'application/pdf',
        fileName:   `${safe}_batch_${ts}_${batchPhotos.length}pages.pdf`,
        employeeId: s.employeeId,
        capturedAt: new Date().toISOString(),
        pageCount:  batchPhotos.length,
        status:     'queued',
        attempts:   0,
        lastError:  null,
        fileType:   'pdf',
      };

      await pqAdd(record);
      clearBatch();
      statusMsg.textContent = `PDF (${record.pageCount} pages) saved on this device.`;
      statusMsg.className   = 'status-msg status-msg--ok';
      await renderQueue();
      attemptFlush();
      registerBackgroundSync();
    } catch (err) {
      statusMsg.textContent = 'Failed to build PDF: ' + err.message;
      statusMsg.className   = 'status-msg status-msg--fail';
    } finally {
      createPdfBtn.disabled = false;
      pdfProgressWrap.classList.add('pdf-progress-wrap--hidden');
    }
  });

  // ---------- PDF generation with pdf-lib ----------
  async function buildPdf(photos, onProgress) {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.create();

    for (let i = 0; i < photos.length; i++) {
      const { blob } = photos[i];

      // Always convert via canvas. The browser draws the image through an <img>
      // element which automatically applies the EXIF orientation tag, so portrait
      // photos taken on a phone are correctly upright before the pixels are
      // embedded — regardless of the original file format.
      const jpegBytes = await convertToJpeg(blob);
      const image = await doc.embedJpg(jpegBytes);

      // A4 portrait: 595 x 842 pt. Fit image inside with 20pt margin.
      const pageW = 595, pageH = 842, margin = 20;
      const maxW  = pageW - margin * 2;
      const maxH  = pageH - margin * 2;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const drawW = image.width  * scale;
      const drawH = image.height * scale;
      const x     = margin + (maxW - drawW) / 2;
      const y     = margin + (maxH - drawH) / 2;

      const page = doc.addPage([pageW, pageH]);
      page.drawImage(image, { x, y, width: drawW, height: drawH });

      if (onProgress) onProgress((i + 1) / photos.length * 0.9);
    }

    const bytes = await doc.save();
    if (onProgress) onProgress(1);
    return bytes;
  }

  function convertToJpeg(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(result => {
          if (!result) return reject(new Error('Canvas conversion failed'));
          result.arrayBuffer().then(resolve).catch(reject);
        }, 'image/jpeg', 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  // ---------- Queue rendering ----------
  async function renderQueue() {
    const records = await pqGetAll();

    // Revoke object URLs for records that no longer exist.
    const liveIds = new Set(records.map(r => r.id));
    for (const [id, url] of queueThumbUrls) {
      if (!liveIds.has(id)) { URL.revokeObjectURL(url); queueThumbUrls.delete(id); }
    }

    queueList.innerHTML = '';
    records.forEach(r => queueList.appendChild(renderQueueItem(r)));

    queueCount.textContent = String(records.length);
    queueEmpty.classList.toggle('empty-queue--hidden', records.length > 0);

    const failedCount = records.filter(r => r.status === 'failed').length;
    retryAllBtn.hidden = failedCount === 0;

    pendingPill.textContent = String(records.length);
    pendingPill.classList.toggle('pending-pill--hidden', records.length === 0);
  }

  function renderQueueItem(record) {
    const isPdf = record.fileType === 'pdf' || record.mimeType === 'application/pdf';

    let thumbHtml;
    if (isPdf) {
      thumbHtml = `<div class="queue-item__pdf-thumb"><span>📄</span>PDF</div>`;
    } else {
      let thumbUrl = queueThumbUrls.get(record.id);
      if (!thumbUrl) {
        thumbUrl = URL.createObjectURL(record.blob);
        queueThumbUrls.set(record.id, thumbUrl);
      }
      thumbHtml = `<img src="${thumbUrl}" alt="" />`;
    }

    const badgeText = { queued:'Waiting', uploading:'Uploading', failed:'Failed' }[record.status] || record.status;
    const time = new Date(record.capturedAt).toLocaleString([], {
      month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
    });

    let subText;
    if (record.status === 'failed' && record.lastError) {
      subText = record.lastError;
    } else if (isPdf) {
      subText = `${record.employeeId} · ${record.pageCount} pages · ${time}`;
    } else {
      subText = `${record.employeeId} · ${time}`;
    }

    const li = document.createElement('li');
    li.className = 'queue-item';
    li.innerHTML = `
      ${thumbHtml}
      <div class="queue-item__meta">
        <div class="queue-item__name">${escapeHtml(record.employeeId)}${isPdf ? ' <em style="font-weight:400;font-size:11px">(PDF)</em>' : ''}</div>
        <div class="queue-item__sub">${escapeHtml(subText)}</div>
      </div>
      <span class="queue-badge queue-badge--${record.status}">${badgeText}</span>
      <button class="queue-item__delete" aria-label="Discard">✕</button>
    `;
    li.querySelector('.queue-item__delete').addEventListener('click', async () => {
      await pqDelete(record.id);
      await renderQueue();
    });
    return li;
  }

  retryAllBtn.addEventListener('click', () => attemptFlush());

  // ---------- Flush ----------
  let flushInFlight = false;
  async function attemptFlush() {
    if (flushInFlight || !navigator.onLine) return;
    flushInFlight = true;
    try { await pqFlush(() => renderQueue()); }
    finally { flushInFlight = false; renderQueue(); }
  }

  async function registerBackgroundSync() {
    if (!swRegistration || !('sync' in swRegistration)) return;
    try { await swRegistration.sync.register(SYNC_TAG); } catch {}
  }

  // ---------- Online / offline ----------
  function updateOnlineStatus() {
    offlineBanner.classList.toggle('banner--hidden', navigator.onLine);
    if (navigator.onLine) attemptFlush();
  }
  window.addEventListener('online',  updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') attemptFlush();
  });
  setInterval(attemptFlush, FLUSH_INTERVAL_MS);

  // ---------- Auto-update manager ----------
  const updateBanner    = document.getElementById('updateBanner');
  const updateBannerMsg = document.getElementById('updateBannerMsg');
  const updateNowBtn    = document.getElementById('updateNowBtn');

  const CONFIG_POLL_MS    = 5 * 60 * 1000;   // poll /api/version every 5 min
  const SW_CHECK_MS       = 60 * 1000;        // nudge SW to check for updates every 60 s

  let pendingSwUpdate = false;  // a new SW is waiting
  let configChanged   = false;  // server config fingerprint changed

  // Show the update banner with appropriate message. If the queue is empty
  // and the trigger is a new SW, auto-reload silently. Otherwise surface the
  // banner so the user can choose when to update (after their current upload).
  async function handleUpdateAvailable(reason) {
    const queueItems = await pqGetAll();
    const queued     = queueItems.filter(r => r.status !== 'uploaded').length;

    if (reason === 'sw') {
      updateBannerMsg.textContent = queued > 0
        ? `A new version is ready. Tap to update after your ${queued} pending upload${queued > 1 ? 's finish' : ' finishes'}.`
        : 'A new version is ready.';
    } else {
      updateBannerMsg.textContent = queued > 0
        ? 'Server settings have changed. Tap to reload after your uploads finish.'
        : 'Server settings have changed — reloading…';
    }

    updateBanner.classList.remove('banner--hidden');

    // Auto-reload only when nothing is at risk of being lost.
    if (queued === 0) {
      await new Promise(r => setTimeout(r, reason === 'sw' ? 400 : 1200));
      applyUpdate();
    }
  }

  function applyUpdate() {
    if (pendingSwUpdate && swRegistration && swRegistration.waiting) {
      // Tell the waiting SW to activate; it will broadcast SW_UPDATED once it
      // has claimed all clients, and the message handler below reloads the page.
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // Config-only change or SW already active — a plain reload picks up any
      // new cached assets and re-runs settings validation.
      location.reload();
    }
  }

  updateNowBtn.addEventListener('click', applyUpdate);

  // SW update detection — fires when a new SW finishes downloading.
  function trackSwRegistration(reg) {
    function onWaiting() {
      pendingSwUpdate = true;
      handleUpdateAvailable('sw');
    }
    if (reg.waiting) { onWaiting(); return; }
    reg.addEventListener('updatefound', () => {
      const newSw = reg.installing;
      if (!newSw) return;
      newSw.addEventListener('statechange', () => {
        if (newSw.state === 'installed' && navigator.serviceWorker.controller) {
          onWaiting();
        }
      });
    });
  }

  // Reload when the new SW broadcasts SW_UPDATED after claiming clients.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'queue-updated') { renderQueue(); return; }
    if (event.data.type === 'SW_UPDATED')    { location.reload(); }
  });

  // Periodically nudge the SW to check for updates (browser normally does this
  // on navigation, which rarely happens in a single-page PWA).
  function startSwUpdatePolling(reg) {
    setInterval(() => reg.update().catch(() => {}), SW_CHECK_MS);
  }

  // Config version polling — detect server restarts, key rotations, etc.
  async function checkConfigVersion() {
    const s = loadSettings();
    if (!settingsComplete(s)) return;
    try {
      const res = await fetch(`${s.serverUrl}/api/version`, { cache: 'no-store' });
      if (!res.ok) return;
      const { configHash } = await res.json();
      const stored = localStorage.getItem(CONFIG_HASH_KEY);
      if (!stored) {
        // First time seeing this server — just store the hash, no alert.
        localStorage.setItem(CONFIG_HASH_KEY, configHash);
        return;
      }
      if (stored !== configHash && !configChanged) {
        configChanged = true;
        localStorage.setItem(CONFIG_HASH_KEY, configHash);
        handleUpdateAvailable('config');
      }
    } catch { /* offline or server unreachable — ignore */ }
  }

  function startConfigPolling() {
    checkConfigVersion();
    setInterval(checkConfigVersion, CONFIG_POLL_MS);
  }
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.classList.remove('install-btn--hidden');
  });
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.classList.add('install-btn--hidden');
  });
  window.addEventListener('appinstalled', () => installBtn.classList.add('install-btn--hidden'));

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        swRegistration = await navigator.serviceWorker.register('service-worker.js');
        trackSwRegistration(swRegistration);
        startSwUpdatePolling(swRegistration);
      } catch (err) {
        console.warn('SW registration failed:', err);
      }
    });
  }

  startConfigPolling();

  updateOnlineStatus();
  init();
})();
