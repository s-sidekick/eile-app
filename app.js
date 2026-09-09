/* エイル PWA v0.3.2 — ボイスジャーナル & タスク（GAS バックエンドと通信） */
'use strict';

// ===== 設定（スマホの中だけに保存。GitHubには置かない）=====
const store = {
  get url() { return localStorage.getItem('eile_url') || ''; },
  set url(v) { localStorage.setItem('eile_url', v.trim()); },
  get pin() { return localStorage.getItem('eile_pin') || ''; },
  set pin(v) { localStorage.setItem('eile_pin', v.trim()); },
};

const IMG_VER = '2'; // 画像を差し替えたら数字を上げる（キャッシュ対策）
const THEMES = ['仕事', '思想', 'AI', '家族', '健康', '顧客', 'お金'];
const MOODS = ['良い', '普通', '低め', '高揚', '疲れ'];
const STEPS = ['なし', '足す', '引く', '変える'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const addDaysLocal = n => { const d = new Date(Date.now() + n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let draft = null;       // 文字起こし結果（確認画面の元データ）
let rec = null;         // 録音中の状態

// ===== エイル（表情とひとこと）=====
const eileEl = $('.eile'), eileImg = $('#eile-img'), eileSay = $('#eile-say');
function eile(state, text) {
  eileEl.className = 'eile is-' + state;
  eileImg.src = './img/eile_' + state + '.png?v=' + IMG_VER;
  if (text != null) eileSay.textContent = text;
}

// ===== GAS API =====
async function api(action, data = {}) {
  if (!store.url || !store.pin) throw new Error('設定画面でURLと合言葉を入れてください');
  const res = await fetch(store.url, { method: 'POST', body: JSON.stringify({ action, pin: store.pin, ...data }) });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('サーバーの応答が読めません（GASの再デプロイ忘れ、またはURL違いの可能性）'); }
  if (!j.ok) throw new Error(j.error || 'エラー');
  return j;
}

// ===== 未送信キュー（電波が無いときの保険：IndexedDB）=====
function idb() {
  return new Promise((ok, ng) => {
    const r = indexedDB.open('eile', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
  });
}
async function queuePut(item) { const db = await idb(); return new Promise((ok, ng) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(item); tx.oncomplete = ok; tx.onerror = () => ng(tx.error); }); }
async function queueAll() { const db = await idb(); return new Promise((ok, ng) => { const r = db.transaction('pending').objectStore('pending').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => ng(r.error); }); }
async function queueDel(id) { const db = await idb(); return new Promise((ok, ng) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').delete(id); tx.oncomplete = ok; tx.onerror = () => ng(tx.error); }); }

// ===== 画面遷移 =====
const app = $('#app'), titleEl = $('#title'), backBtn = $('#btn-back');
$('#btn-settings').onclick = () => go('settings');
backBtn.onclick = () => history.back();
window.addEventListener('hashchange', render);

function go(path) { location.hash = path ? '#/' + path : ''; }
function seg() { return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean); }

function render() {
  stopRecorder();
  const s = seg();
  const key = s[0] || 'home';
  const screens = { home, journal, task, review, settings };
  backBtn.hidden = key === 'home';
  (screens[key] || home)(s);
  window.scrollTo(0, 0);
}

// ===== ホーム =====
async function home() {
  titleEl.textContent = 'エイル';
  eile('idle', 'おかえりなさい。何を記録しますか？');
  app.innerHTML = `
    ${!store.url ? `<div class="notice">はじめに <a href="#/settings">設定</a> でGASのURLと合言葉を入れてください。</div>` : ''}
    <div id="pending"></div>
    <div id="today"></div>
    <div class="tiles">
      <button class="tile" data-go="journal"><span>ボイスジャーナル<small>今日の考え・判断・違和感を話す</small></span><span>›</span></button>
      <button class="tile" data-go="task"><span>タスク<small>やることを話して登録・完了</small></span><span>›</span></button>
    </div>`;
  bindGo();
  if (store.url && store.pin) {
    api('listReviews', { kind: '日次' }).then(({ reviews }) => {
      const r = reviews[0];
      if (!r) return;
      const d0 = addDaysLocal(-1);
      const fresh = r.start === d0;
      $('#today').innerHTML = `<div class="tiles" style="margin-bottom:12px"><button class="tile" data-go="review/day/${r.id}"><span>${fresh ? '今朝のレビュー' : '最新のレビュー'}<small>${esc(r.title)}</small></span><span>›</span></button></div>`;
      bindGo();
      if (fresh) eile('idle', 'おはようございます。今朝のレビューができています。');
    }).catch(() => {});
  }
  try {
    const items = await queueAll();
    if (items.length) {
      $('#pending').innerHTML = `<div class="notice">未送信の録音が ${items.length} 件あります。<button class="btn" id="send-pending">送る</button></div>`;
      $('#send-pending').onclick = () => sendPending(items[0]);
    }
  } catch (_) {}
}

function bindGo() { $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go)); }

// ===== ボイスジャーナル =====
function journal(s) {
  if (s[1] === 'record') return recordScreen('journal');
  if (s[1] === 'confirm') return journalConfirm();
  if (s[1] === 'done') return doneScreen();
  titleEl.textContent = 'ボイスジャーナル';
  eile('idle', '話してくれたことを、あとで振り返れる形に整えます。');
  app.innerHTML = `
    <div class="tiles">
      <button class="tile accent" data-go="journal/record"><span>入力<small>録音して、確認してから登録</small></span><span>›</span></button>
      <button class="tile" data-go="review/day"><span>レビュー<small>1日・1週間・1ヵ月の振り返り</small></span><span>›</span></button>
    </div>`;
  bindGo();
}

// ===== タスク =====
function task(s) {
  if (s[1] === 'record') return recordScreen('task');
  if (s[1] === 'confirm') return taskConfirm();
  if (s[1] === 'list') return taskList();
  if (s[1] === 'done') return doneScreen();
  titleEl.textContent = 'タスク';
  eile('idle', 'やることを話すと、期限を読み取って登録します。');
  app.innerHTML = `
    <div class="tiles">
      <button class="tile accent" data-go="task/record"><span>入力<small>話して登録。Chatworkのタスク欄にも入ります</small></span><span>›</span></button>
      <button class="tile" data-go="task/list"><span>管理<small>未完のタスクを見て、完了にする</small></span><span>›</span></button>
    </div>`;
  bindGo();
}

// ===== 録音（ジャーナル・タスク共通）=====
function recordScreen(kind) {
  titleEl.textContent = kind === 'task' ? 'タスクを話す' : 'ジャーナルを話す';
  eile('idle', kind === 'task' ? '「〇〇を金曜まで」のように、期限も一緒に。' : '準備ができたら、マイクを押してください。');
  app.innerHTML = `
    <div class="rec">
      <div class="time" id="time">00:00</div>
      <button class="mic" id="mic">録音する</button>
      <p class="hint" id="hint">${kind === 'task' ? '短く1件ずつが読み取りやすいです。' : '話し終えたら「止める」。10分を超えると区切ることをおすすめします。'}</p>
    </div>`;
  const mic = $('#mic'), time = $('#time'), hint = $('#hint');
  mic.onclick = async () => {
    if (!rec) {
      try { await startRecorder(kind); }
      catch (err) { eile('warn', 'マイクが使えません。ブラウザのマイク許可を確認してください。'); hint.textContent = String(err.message || err); return; }
      mic.textContent = '止める'; mic.classList.add('stop', 'pulse');
      eile('listening', '聞いています。');
      rec.timer = setInterval(() => {
        const sec = Math.floor((Date.now() - rec.startedAt) / 1000);
        time.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
        if (sec >= 15 * 60) mic.click(); // 15分で自動停止（送信サイズの上限対策）
      }, 500);
    } else {
      mic.disabled = true; mic.classList.remove('pulse'); mic.textContent = '送信中…';
      const blob = await stopRecorder();
      await sendAudio(kind, blob);
    }
  };
}

async function startRecorder(kind) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec = { kind, mr, stream, chunks, mime: mr.mimeType || mime || 'audio/webm', startedAt: Date.now(), timer: null };
  mr.start(1000);
}

function stopRecorder() {
  if (!rec) return Promise.resolve(null);
  const r = rec; rec = null;
  clearInterval(r.timer);
  return new Promise(ok => {
    r.mr.onstop = () => { r.stream.getTracks().forEach(t => t.stop()); ok(new Blob(r.chunks, { type: r.mime })); };
    if (r.mr.state !== 'inactive') r.mr.stop(); else r.mr.onstop();
  });
}

function blobToBase64(blob) {
  return new Promise((ok, ng) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = () => ng(fr.error); fr.readAsDataURL(blob); });
}

async function sendAudio(kind, blob, pendingId) {
  if (!blob || !blob.size) { eile('warn', '録音が空でした。もう一度お願いします。'); go(kind); return; }
  eile('thinking', '文字にして、整理しています。少し待ってください…');
  try {
    const audio = await blobToBase64(blob);
    const r = await api('transcribe', { kind, audio, mime: blob.type || 'audio/webm' });
    draft = { ...r, pendingId: pendingId || null };
    if (pendingId) await queueDel(pendingId);
    go(kind + '/confirm');
  } catch (err) {
    if (!pendingId) { try { await queuePut({ id: 'p' + Date.now(), kind, blob, mime: blob.type, created: Date.now() }); } catch (_) {} }
    eile('warn', '送れませんでした。録音はこの端末に残したので、あとでホームから送れます。');
    app.innerHTML = `<div class="notice warn">${esc(err.message || err)}</div><div class="actions"><button class="btn" data-go="">ホームへ</button></div>`;
    bindGo();
  }
}

async function sendPending(item) {
  await sendAudio(item.kind, item.blob, item.id);
}

// ===== ジャーナル確認 =====
function journalConfirm() {
  if (!draft || draft.kind !== 'journal') return go('journal');
  const j = draft.journal;
  titleEl.textContent = '確認して登録';
  eile('done', '整理しました。固有名詞など、違うところだけ直してください。');
  app.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="row">
        <div class="field"><label>日付</label><input type="date" name="date" value="${esc(draft.date)}"></div>
        <div class="field"><label>気分・状態</label><select name="mood">${MOODS.map(m => `<option ${m === j.mood ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>タイトル</label><input name="title" value="${esc(j.title)}"></div>
      <div class="field"><label>テーマ</label><div class="chips" id="themes">${THEMES.map(t => `<button type="button" class="chip ${j.themes.includes(t) ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>本文（誤認識の修正だけで十分です）</label><textarea name="text" class="long">${esc(j.text)}</textarea></div>
      <div class="field"><label>判断したこと</label><textarea name="decision">${esc(j.decision)}</textarea></div>
      <div class="field"><label>判断の根拠</label><textarea name="rationale">${esc(j.rationale)}</textarea></div>
      <div class="row">
        <div class="field"><label>足す・引く・変える</label><select name="step">${STEPS.map(m => `<option ${m === j.step ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>反復する問い</label><textarea name="question">${esc(j.question)}</textarea></div>
      <div class="field"><label>違和感</label><textarea name="discomfort">${esc(j.discomfort)}</textarea></div>
      <div class="field"><label>話の中に出てきたタスク（チェックするとタスクにも登録）</label>
        <div class="tasklist" id="tasks">${j.tasks.map((t, i) => taskRow(t, i)).join('')}</div>
        <button type="button" class="btn quiet" id="add-task">＋ タスクを足す</button>
      </div>
      <p class="small">元の文字起こしと音声はDriveに保存済みです。</p>
      <div class="actions">
        <button type="submit" class="btn primary">Notionに登録する</button>
        <button type="button" class="btn quiet" data-go="journal">やめる</button>
      </div>
    </form>`;
  bindGo();
  $('#themes').onclick = e => { const b = e.target.closest('.chip'); if (b) b.classList.toggle('on'); };
  $('#add-task').onclick = () => { $('#tasks').insertAdjacentHTML('beforeend', taskRow({ title: '', due: null }, Date.now())); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      date: f.get('date'), title: f.get('title'), mood: f.get('mood'), step: f.get('step'), text: f.get('text'),
      decision: f.get('decision'), rationale: f.get('rationale'), question: f.get('question'), discomfort: f.get('discomfort'),
      themes: $$('#themes .chip.on').map(b => b.dataset.t),
      tasks: $$('#tasks .row3').map(r => ({ register: $('input[type=checkbox]', r).checked, title: $('input[name=tt]', r).value.trim(), due: $('input[name=td]', r).value || null })).filter(t => t.title),
      audioUrl: draft.audioUrl, baseName: draft.baseName,
    };
    await save('saveJournal', body, r => ({ url: r.pageUrl, extra: r.taskNums.length ? 'タスク TK-' + r.taskNums.join(', TK-') + ' も登録しました。' : '' }), 'journal');
  };
}

function taskRow(t, i) {
  return `<div class="row3"><input type="checkbox" ${t.register ? 'checked' : ''} aria-label="タスクにも登録"><input name="tt" placeholder="タスク名" value="${esc(t.title)}"><input name="td" type="date" value="${esc(t.due || '')}"></div>`;
}

// ===== タスク確認 =====
function taskConfirm() {
  if (!draft || draft.kind !== 'task') return go('task');
  const t = draft.task;
  titleEl.textContent = '確認して登録';
  eile('done', 'こう聞き取りました。期限を確認してください。');
  app.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="field"><label>タスク名</label><input name="title" value="${esc(t.title)}" required></div>
      <div class="field"><label>期限（無ければ空欄）</label><input name="due" type="date" value="${esc(t.due || '')}"></div>
      <div class="field"><label>詳細</label><textarea name="detail">${esc(t.detail)}</textarea></div>
      <p class="small">聞き取り：${esc(draft.transcript)}</p>
      <div class="actions">
        <button type="submit" class="btn primary">登録する</button>
        <button type="button" class="btn quiet" data-go="task">やめる</button>
      </div>
    </form>`;
  bindGo();
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await save('saveTask', { title: f.get('title'), due: f.get('due') || null, detail: f.get('detail'), audioUrl: draft.audioUrl },
      r => ({ url: null, extra: 'TK-' + r.num + ' として登録しました。' + (r.chatworkTask ? 'Chatworkのタスク欄にも入っています。' : '') }), 'task');
  };
}

async function save(action, body, summarize, back) {
  const btn = $('#f button[type=submit]'); btn.disabled = true; btn.textContent = '登録中…';
  eile('thinking', '登録しています…');
  try {
    const r = await api(action, body);
    draft = { done: summarize(r), back };
    go(back + '/done');
  } catch (err) {
    btn.disabled = false; btn.textContent = '登録する';
    eile('warn', '登録できませんでした。' + (err.message || err));
  }
}

function doneScreen() {
  const d = (draft && draft.done) || {};
  titleEl.textContent = '登録しました';
  eile('done', 'お疲れさまです。記録しました。');
  app.innerHTML = `
    <div class="done"><div class="big">登録しました</div><p>${esc(d.extra || '')}</p>${d.url ? `<p><a href="${esc(d.url)}" target="_blank" rel="noopener">Notionで開く</a></p>` : ''}</div>
    <div class="actions">
      <button class="btn primary" data-go="${draft && draft.back ? draft.back + '/record' : ''}">もう1件</button>
      <button class="btn" data-go="">ホームへ</button>
    </div>`;
  bindGo();
}

// ===== タスク一覧 =====
async function taskList() {
  titleEl.textContent = '未完のタスク';
  eile('thinking', '一覧を取りに行っています…');
  app.innerHTML = `<div class="empty">読み込み中…</div>`;
  try {
    const { tasks } = await api('listTasks');
    eile('idle', tasks.length ? `未完は ${tasks.length} 件です。` : '未完のタスクはありません。');
    if (!tasks.length) { app.innerHTML = `<div class="empty">すべて片づいています。</div>`; return; }
    const today = addDaysLocal(0);
    app.innerHTML = `<div class="list">${tasks.map(t => `
      <div class="item">
        <div><div class="t"><span class="num">TK-${t.num}</span>${esc(t.title)}</div>
          <div class="m">${t.due ? `<span class="${t.due < today ? 'over' : ''}">期限 ${esc(t.due.slice(5).replace('-', '/'))}</span>` : '期限なし'}${t.assignee ? '・' + esc(t.assignee) : ''}${t.status === '進行中' ? '・進行中' : ''}</div></div>
        <button data-num="${t.num}">完了</button>
      </div>`).join('')}</div>`;
    $$('.item button').forEach(b => b.onclick = async () => {
      if (!confirm('TK-' + b.dataset.num + ' を完了にしますか？')) return;
      b.disabled = true; b.textContent = '…';
      try { await api('completeTask', { num: Number(b.dataset.num) }); taskList(); }
      catch (err) { b.disabled = false; b.textContent = '完了'; eile('warn', err.message || String(err)); }
    });
  } catch (err) {
    eile('warn', '取得できませんでした。');
    app.innerHTML = `<div class="notice warn">${esc(err.message || err)}</div>`;
  }
}

// ===== レビュー =====
async function review(s) {
  const kind = s[1] || 'day';
  const label = { day: '日次', week: '週次', month: '月次' };
  titleEl.textContent = 'レビュー';
  app.innerHTML = `
    <div class="tabs">${Object.keys(label).map(k => `<button class="${k === kind ? 'on' : ''}" data-go="review/${k}">${k === 'day' ? '1日' : k === 'week' ? '1週間' : '1ヵ月'}</button>`).join('')}</div>
    <div id="rv" class="list"><div class="empty">読み込み中…</div></div>`;
  bindGo();
  if (s[2]) return reviewDetail(s[2]);
  eile('thinking', 'レビューを探しています…');
  try {
    const { reviews } = await api('listReviews', { kind: label[kind] || '日次' });
    if (!reviews.length) { eile('idle', 'まだこの期間のレビューはありません。'); $('#rv').innerHTML = `<div class="empty">まだありません。毎朝7時に自動で作る予定です。</div>`; return; }
    eile('idle', `${label[kind]}レビューが ${reviews.length} 件あります。`);
    $('#rv').innerHTML = reviews.map(r => `<div class="item link" data-go="review/${kind}/${r.id}"><div><div class="t">${esc(r.title)}</div><div class="m">${esc(r.start || '')}${r.end ? ' 〜 ' + esc(r.end) : ''}</div></div><span>›</span></div>`).join('');
    bindGo();
  } catch (err) { eile('warn', '取得できませんでした。'); $('#rv').innerHTML = `<div class="notice warn">${esc(err.message || err)}</div>`; }
}

async function reviewDetail(id) {
  eile('thinking', '開いています…');
  try {
    const { text } = await api('getReview', { id });
    eile('idle', 'どうぞ。');
    $('#rv').innerHTML = `<div class="readbox">${esc(text)}</div>`;
  } catch (err) { eile('warn', '開けませんでした。'); $('#rv').innerHTML = `<div class="notice warn">${esc(err.message || err)}</div>`; }
}

// ===== 設定 =====
function settings() {
  titleEl.textContent = '設定';
  eile('idle', 'GASのURLと合言葉を入れると、私とつながります。');
  app.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="field"><label>GAS ウェブアプリのURL（/exec で終わるもの）</label><input name="url" value="${esc(store.url)}" placeholder="https://script.google.com/macros/s/…/exec" inputmode="url"></div>
      <div class="field"><label>合言葉（GASの APP_PIN と同じもの）</label><input name="pin" type="password" value="${esc(store.pin)}" inputmode="numeric"></div>
      <div class="actions">
        <button type="submit" class="btn primary">保存して接続テスト</button>
        <button type="button" class="btn quiet" id="reload">アプリを最新版に更新</button>
      </div>
      <p class="small">これらはこの端末の中だけに保存されます。ホーム画面に追加すると、アプリとして開けます（Chromeのメニュー →「ホーム画面に追加」）。</p>
      <p class="small">v0.3.2</p>
    </form>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    store.url = f.get('url'); store.pin = f.get('pin');
    eile('thinking', '接続を確認しています…');
    try { const r = await api('ping'); eile('done', `つながりました。サーバー時刻 ${r.time.slice(11, 16)}。`); }
    catch (err) { eile('warn', '接続できません。' + (err.message || err)); }
  };
  $('#reload').onclick = async () => {
    if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); }
    if (window.caches) { for (const k of await caches.keys()) await caches.delete(k); }
    location.reload();
  };
}

// ===== 起動 =====
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
render();
