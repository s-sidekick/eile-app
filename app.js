/* エイル PWA v0.9.0 — ボイスジャーナル & タスク & メモ（GAS バックエンドと通信） */
/* v0.7.0：タスクの確認画面に「顧客」（顧客マスタと1件だけ一致したもの）を表示し、外す・戻すができる */
/* v0.8.0：「エイルの部屋」（書斎兼ティールーム）を追加。用意した台詞の切替だけで、通信・録音・保存はしない */
/* v0.8.1：部屋の見た目の微調整（日付カードを小さく・狭い舞台では短い一言、閉じた画面では飾り文を省略、会話欄の余白を詰める） */
/* v0.9.0：「メモ」を追加。思いついたことを話す → 確認（タイトル・テーマ・本文）→ Notion メモDBに登録。ジャーナルとは別。週次・月次レビューの材料になる */
/* v0.10.0：タスクの保存先を毎回「事務所」「個人」から選ぶ（どちらも最初から選んだ状態にはしない）。ジャーナルの中のタスクも1件ずつ選ぶ。
            一覧は「事務所（井上の分／全員分）」と「個人」。確認待ちを表示。エイルで登録した未着手の行は反対の表へ移せる */
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
const STAFF = ['井上', '末吉', '河津'];     // v0.10.0：事務所の表の担当者（Notion の選択肢と同じ）
const DEST_NOTE = '「事務所」は末吉さん・河津さんも読みます。個人的な事情や直通LINEの中身は書かないでください。迷ったら「個人」へ。'; // v0.10.0

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
  if (rec) { // 録音中に画面を離れた → 破棄せず端末に保留
    const r = rec;
    stopRecorder().then(blob => {
      if (blob && blob.size > 2000) queuePut({ id: 'p' + Date.now(), kind: r.kind, blob, mime: blob.type, created: r.startedAt }).then(() => {
        eile('warn', '録音を途中で離れたので、端末に保留しました。ホームから送れます。');
      }).catch(() => {});
    });
  }
  const s = seg();
  const key = s[0] || 'home';
  const screens = { home, journal, task, memo, review, settings, room };
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
      <button class="tile" data-go="memo"><span>メモ<small>思いついたことを、ひとこと。週次・月次で見返す</small></span><span>›</span></button>
      <button class="tile room-entry" data-go="room"><span>エイルの部屋<small>エイルと、ひと息つく</small></span><span>›</span></button>
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
  if (s[1] === 'list') return taskList(s[2]);   // v0.10.0：task/list/all で全員分
  if (s[1] === 'done') return doneScreen();
  titleEl.textContent = 'タスク';
  eile('idle', 'やることを話すと、期限を読み取って登録します。');
  app.innerHTML = `
    <div class="tiles">
      <button class="tile accent" data-go="task/record"><span>入力<small>話して、「事務所」か「個人」かを選んで登録</small></span><span>›</span></button>
      <button class="tile" data-go="task/list"><span>管理<small>事務所と個人の未完のタスクを見て、完了にする</small></span><span>›</span></button>
    </div>`;
  bindGo();
}

// ===== メモ（v0.9.0）=====
// メニューは無く、タイルからそのまま録音画面へ。確認 → 登録の流れはジャーナルと同じ（確認画面を経てから Notion に入る）
function memo(s) {
  if (s[1] === 'confirm') return memoConfirm();
  if (s[1] === 'done') return doneScreen();
  return recordScreen('memo');
}

// ===== 録音（ジャーナル・タスク・メモ共通）=====
function recordScreen(kind) {
  titleEl.textContent = kind === 'task' ? 'タスクを話す' : kind === 'memo' ? 'メモを話す' : 'ジャーナルを話す';
  eile('idle', kind === 'task' ? '「〇〇を金曜まで」のように、期限も一緒に。' : kind === 'memo' ? '思いついたことを、そのまま話してください。' : '準備ができたら、マイクを押してください。');
  app.innerHTML = `
    <div class="rec">
      <div class="time" id="time">00:00</div>
      <button class="mic" id="mic">録音する</button>
      <p class="hint" id="hint">${kind === 'task' ? '短く1件ずつが読み取りやすいです。' : kind === 'memo' ? '短くて大丈夫です。週次・月次のレビューで見返します。' : '話し終えたら「止める」。10分を超えると区切ることをおすすめします。'}</p>
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
      const startedAt = rec.startedAt;
      const blob = await stopRecorder();
      await sendAudio(kind, blob, null, startedAt);
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

async function sendAudio(kind, blob, pendingId, recordedAt) {
  if (!blob || !blob.size) { eile('warn', '録音が空でした。もう一度お願いします。'); go(kind); return; }
  eile('thinking', '文字にして、整理しています。少し待ってください…');
  const recorded = new Date(recordedAt || Date.now()).toISOString(); // 録音した時刻（再送でも記録日は録音日）
  try {
    const audio = await blobToBase64(blob);
    const r = await api('transcribe', { kind, audio, mime: blob.type || 'audio/webm', recordedAt: recorded });
    draft = { ...r, pendingId: pendingId || null };
    if (pendingId) await queueDel(pendingId);
    go(kind + '/confirm');
  } catch (err) {
    let kept = !!pendingId;
    if (!pendingId) { try { await queuePut({ id: 'p' + Date.now(), kind, blob, mime: blob.type, created: recordedAt || Date.now() }); kept = true; } catch (_) {} }
    eile('warn', kept ? '送れませんでした。録音はこの端末に残したので、あとでホームから送れます。' : '送れず、端末への保存もできませんでした。この録音は失われます。');
    app.innerHTML = `<div class="notice warn">${esc(err.message || err)}</div><div class="actions"><button class="btn" data-go="">ホームへ</button></div>`;
    bindGo();
  }
}

async function sendPending(item) {
  await sendAudio(item.kind, item.blob, item.id, item.created);
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
      <div class="field"><label>話の中に出てきたタスク（登録するものだけ、保存先を「事務所」か「個人」にする）</label>
        <div class="tasklist" id="tasks">${j.tasks.map((t, i) => taskRow(t, i, !draft.server)).join('')}</div>
        <button type="button" class="btn quiet" id="add-task">＋ タスクを足す</button>
        <p class="small">${draft.server ? esc(DEST_NOTE) + '事務所に入れるタスクには、ジャーナルの見出しと音声のリンクは書きません。' : 'GAS が古い版のため、ここからタスクは登録できません（手順書のとおり GAS を先に更新してください）。'}</p>
      </div>
      <p class="small">元の文字起こしと音声はDriveに保存済みです。</p>
      <div class="actions">
        <button type="submit" class="btn primary">Notionに登録する</button>
        <button type="button" class="btn quiet" data-go="journal">やめる</button>
      </div>
    </form>`;
  bindGo();
  $('#themes').onclick = e => { const b = e.target.closest('.chip'); if (b) b.classList.toggle('on'); };
  $('#add-task').onclick = () => { $('#tasks').insertAdjacentHTML('beforeend', taskRow({ title: '', due: null }, Date.now(), !draft.server)); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      date: f.get('date'), title: f.get('title'), mood: f.get('mood'), step: f.get('step'), text: f.get('text'),
      decision: f.get('decision'), rationale: f.get('rationale'), question: f.get('question'), discomfort: f.get('discomfort'),
      themes: $$('#themes .chip.on').map(b => b.dataset.t),
      // v0.10.0：保存先（''＝登録しない／office／personal）。古い GAS のときは送らない
      tasks: $$('#tasks .row3').map(r => ({ dest: draft.server ? $('select[name=tdest]', r).value : '', title: $('input[name=tt]', r).value.trim(), due: $('input[name=td]', r).value || null })).filter(t => t.title),
      audioUrl: draft.audioUrl, baseName: draft.baseName, recId: draft.recId,
    };
    await save('saveJournal', body, r => ({ url: r.pageUrl, extra: (r.duplicate ? 'この録音は登録済みでした（二重登録は防ぎました）。' : '')
      + ((r.taskNums || []).length ? '事務所の表に TK-' + r.taskNums.join(', TK-') + ' を登録しました。' : '')
      + ((r.personalNums || []).length ? '個人の表に MY-' + r.personalNums.join(', MY-') + ' を登録しました。' : '') }), 'journal');
  };
}

/* v0.10.0：チェックの代わりに保存先を選ぶ。最初は「登録しない」（事務所・個人のどちらも既定にしない） */
function taskRow(t, i, locked) {
  return `<div class="row3"><select name="tdest" aria-label="保存先" ${locked ? 'disabled' : ''}><option value="">登録しない</option><option value="office">事務所</option><option value="personal">個人</option></select><input name="tt" placeholder="タスク名" value="${esc(t.title)}"><input name="td" type="date" value="${esc(t.due || '')}"></div>`;
}

// ===== メモ確認（v0.9.0）=====
// 直せるのは日付・タイトル・テーマ・本文だけ。判断・気分などの項目は無い。タスクDBには入らない
function memoConfirm() {
  if (!draft || draft.kind !== 'memo') return go('memo');
  const m = draft.memo;
  titleEl.textContent = '確認して登録';
  eile('done', 'こう聞き取りました。違うところだけ直してください。');
  app.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="row">
        <div class="field"><label>日付</label><input type="date" name="date" value="${esc(draft.date)}"></div>
      </div>
      <div class="field"><label>タイトル</label><input name="title" value="${esc(m.title)}"></div>
      <div class="field"><label>テーマ</label><div class="chips" id="themes">${THEMES.map(t => `<button type="button" class="chip ${m.themes.includes(t) ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>本文（誤認識の修正だけで十分です）</label><textarea name="text" class="long" required>${esc(m.text)}</textarea></div>
      <p class="small">元の文字起こしと音声はDriveに保存済みです。このメモは週次・月次のレビューで見返します。</p>
      <div class="actions">
        <button type="submit" class="btn primary">Notionに登録する</button>
        <button type="button" class="btn quiet" data-go="">やめる</button>
      </div>
    </form>`;
  bindGo();
  $('#themes').onclick = e => { const b = e.target.closest('.chip'); if (b) b.classList.toggle('on'); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      date: f.get('date'), title: f.get('title'), text: f.get('text'),
      themes: $$('#themes .chip.on').map(b => b.dataset.t),
      audioUrl: draft.audioUrl, baseName: draft.baseName, recId: draft.recId, // v0.10.0：recId＝二重登録防止の鍵（録音ごと）
    };
    await save('saveMemo', body, r => ({ url: r.pageUrl, extra: r.duplicate ? 'この録音は登録済みでした（二重登録は防ぎました）。' : 'メモとして残しました。' }), 'memo');
  };
}

// ===== タスク確認 =====
function taskConfirm() {
  if (!draft || draft.kind !== 'task') return go('task');
  const t = draft.task;
  const matched = t.customer || null;                                      // GASが顧客マスタと1件だけ一致させた顧客（無ければ null）
  const words = Array.isArray(t.customerWords) ? t.customerWords : [];     // Claudeが抜き出した「顧客らしき語」（一致しなかったときの手がかり）
  let customer = matched;                                                  // 「外す」で null、「戻す」で元に戻る。登録時はこの値だけを送る
  const who = STAFF.includes(t.assignee) ? t.assignee : '井上';            // v0.10.0：話の中で末吉さん・河津さんに頼んでいればその人。なければ井上
  const oldServer = !draft.server;                                         // v0.10.0：GAS が古い版なら登録させない（「個人」が事務所に入らないように）
  titleEl.textContent = '確認して登録';
  eile('done', matched ? `こう聞き取りました。顧客は「${matched.name}」で合っていますか？` : 'こう聞き取りました。期限を確認してください。');
  // v0.10.0：登録ボタンは「事務所に登録」「個人に登録」の2つ。どちらも最初から選んだ状態にはせず、押した方に保存する。
  //          ボタンは type="button"（入力欄で Enter を押しても、どちらにも保存されない）
  app.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="field"><label>タスク名</label><input name="title" value="${esc(t.title)}" required></div>
      <div class="field"><label>期限（無ければ空欄）</label><input name="due" type="date" value="${esc(t.due || '')}"></div>
      <div class="field"><label>顧客（顧客マスタと1件だけ一致したときに入ります）</label><div class="cust" id="cust"></div></div>
      <div class="field"><label>担当者（「事務所」に登録するときだけ使います）</label><select name="assignee">${STAFF.map(n => `<option ${n === who ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label>詳細（事務所に登録すると、職員が読みます）</label><textarea name="detail">${esc(t.detail)}</textarea></div>
      <p class="small">聞き取り：${esc(draft.transcript)}</p>
      ${oldServer ? `<div class="notice warn">GAS が古い版のため登録できません。手順書のとおり、先に GAS を v0.10 にしてください。</div>` : ''}
      <p class="small dest-note">保存先を選んでください。${esc(DEST_NOTE)}</p>
      <div class="actions dest">
        <button type="button" class="btn primary" data-dest="office" ${oldServer ? 'disabled' : ''}>事務所に登録</button>
        <button type="button" class="btn primary" data-dest="personal" ${oldServer ? 'disabled' : ''}>個人に登録</button>
        <button type="button" class="btn quiet" data-go="task">やめる</button>
      </div>
    </form>`;
  bindGo();
  const renderCust = () => {
    const box = $('#cust');
    if (matched && customer) box.innerHTML = `<span class="chip on">${esc(customer.name)}</span><button type="button" class="btn quiet" id="cust-toggle">外す</button>`;
    else if (matched) box.innerHTML = `<span class="small">なし（外しました）</span><button type="button" class="btn quiet" id="cust-toggle">戻す</button>`;
    else box.innerHTML = `<span class="small">なし${words.length ? '（「' + esc(words.join('」「')) + '」は顧客マスタに見つからないか、複数の行に当てはまりました）' : ''}</span>`;
    const b = $('#cust-toggle');
    if (b) b.onclick = () => { customer = customer ? null : matched; renderCust(); };
  };
  renderCust();
  $('#f').onsubmit = e => e.preventDefault(); // v0.10.0：Enter キーでは保存しない（保存は2つのボタンだけ）
  $$('#f [data-dest]').forEach(btn => btn.onclick = async () => {
    const form = $('#f');
    if (!form.reportValidity()) return;      // タスク名が空なら止める
    const f = new FormData(form);
    const dest = btn.dataset.dest;
    await save('saveTask', { dest, title: f.get('title'), due: f.get('due') || null, detail: f.get('detail'), assignee: f.get('assignee'), customerId: customer ? customer.id : null, audioUrl: draft.audioUrl, baseName: draft.baseName, recId: draft.recId },
      r => ({ url: null, extra: (r.dest === 'personal' ? '個人の表に ' : '事務所の表に ') + (r.label || 'TK-' + r.num) + ' として登録' + (r.duplicate ? '済みでした（二重登録は防ぎました）。' : 'しました。')
        + (r.dest === 'office' && r.assignee && r.assignee !== '井上' ? '担当は' + r.assignee + 'さんです。' : '')
        + (r.customer ? '顧客「' + r.customer + '」をひも付けました。' : '') + (r.chatworkTask ? 'Chatworkのタスク欄にも入っています。' : '') }), 'task', btn);
  });
}

/* v0.10.0：btn を渡すと、そのボタンを押したものとして扱う（保存先ボタンは2つとも止める）。失敗したら元の文字に戻す */
async function save(action, body, summarize, back, btn) {
  btn = btn || $('#f button[type=submit]');
  const group = btn.dataset.dest ? $$('#f [data-dest]') : [btn];
  const label = btn.textContent;
  group.forEach(b => { b.disabled = true; }); btn.textContent = '登録中…';
  eile('thinking', '登録しています…');
  try {
    const r = await api(action, body);
    draft = { done: summarize(r), back };
    go(back + '/done');
  } catch (err) {
    group.forEach(b => { b.disabled = false; }); btn.textContent = label;
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

// ===== タスク一覧（v0.10.0：事務所と個人の2つ）=====
// 事務所：ふだんは「井上の分」（井上が担当か、井上が頼んだもの）。「全員分」を押すと末吉さん・河津さん同士の分も出す
// 状態が空の行は未着手として扱う。確認待ちは「確認待ち」と出し、完了にできる（頼んだ井上が確かめた、の意味）
async function taskList(scope, note) {
  scope = scope === 'all' ? 'all' : 'mine';
  titleEl.textContent = '未完のタスク';
  eile('thinking', '一覧を取りに行っています…');
  app.innerHTML = `<div class="empty">読み込み中…</div>`;
  try {
    const r = await api('listTasks', { scope });
    const office = (r.office || r.tasks || []).map(t => ({ table: 'office', label: 'TK-' + t.num, ...t }));
    const personal = (r.personal || []).map(t => ({ table: 'personal', label: 'MY-' + t.num, ...t }));
    const total = office.length + personal.length;
    eile(note ? 'done' : 'idle', (note ? note + ' ' : '') + (total ? `未完は 事務所 ${office.length} 件・個人 ${personal.length} 件です。` : '未完のタスクはありません。'));
    const today = addDaysLocal(0);
    const item = t => {
      const st = t.status === '進行中' ? '・進行中' : t.status === '確認待ち' ? '・<b class="st-wait">確認待ち</b>' : '';
      const who = t.table === 'office' ? (t.assignee ? '・担当 ' + esc(t.assignee) : '') + (t.requester && t.requester !== '井上' ? '・依頼 ' + esc(t.requester) : '') : '';
      return `
      <div class="item">
        <div><div class="t"><span class="num">${esc(t.label)}</span>${esc(t.title)}</div>
          <div class="m">${t.due ? `<span class="${t.due < today ? 'over' : ''}">期限 ${esc(t.due.slice(5).replace('-', '/'))}</span>` : '期限なし'}${who}${st}</div></div>
        <div class="item-btns">
          <button data-act="done" data-table="${t.table}" data-num="${t.num}" data-label="${esc(t.label)}" data-wait="${t.status === '確認待ち' ? '1' : ''}">完了</button>
          ${t.movable ? `<button class="quiet" data-act="move" data-table="${t.table}" data-num="${t.num}" data-label="${esc(t.label)}">${t.table === 'office' ? '個人へ移す' : '事務所へ移す'}</button>` : ''}
        </div>
      </div>`;
    };
    const section = (head, list, empty) => `<h3 class="list-head">${head}（${list.length}件）</h3>` + (list.length ? `<div class="list">${list.map(item).join('')}</div>` : `<div class="empty small">${empty}</div>`);
    app.innerHTML = `
      <div class="tabs two"><button class="${scope === 'mine' ? 'on' : ''}" data-go="task/list">井上の分</button><button class="${scope === 'all' ? 'on' : ''}" data-go="task/list/all">全員分</button></div>
      ${r.office ? '' : `<div class="notice warn">GAS が古い版です。事務所の表だけを表示しています。</div>`}
      ${section('事務所' + (scope === 'all' ? '（全員分）' : '（井上が担当か、頼んだもの）'), office, 'ありません。')}
      ${r.office ? section('個人', personal, r.personalError ? esc(r.personalError) : 'ありません。') : ''}`;
    bindGo();
    $$('.item-btns button').forEach(b => b.onclick = async () => {
      const { act, table, num, label, wait } = b.dataset;
      const msg = act === 'done'
        ? label + (wait ? ' を確かめて完了にしますか？' : ' を完了にしますか？')
        : table === 'office'
          ? label + ' を個人の表へ移しますか？\n事務所の表の行は「取消」になり、タスク名と詳細は消えます（Notion の編集履歴には残ります）。' + (r.chatwork ? '\n（Chatwork に出た投稿とタスク欄の名前は消えません。タスク欄は完了になります）' : '')
          : label + ' を事務所の表へ移しますか？\n末吉さん・河津さんも読めるようになります。' + (r.chatwork ? '\n（Chatwork のタスク欄にも入ります）' : '');
      if (!confirm(msg)) return;
      const text = b.textContent;
      const row = $$('button', b.closest('.item-btns'));   // 同じ行のボタンはまとめて止める（完了と移すの同時押しを防ぐ）
      row.forEach(x => { x.disabled = true; }); b.textContent = '…';
      try {
        const out = await api(act === 'done' ? 'completeTask' : 'moveTask', { table, num: Number(num) });
        taskList(scope, act === 'move' ? label + ' を ' + (out.label || '') + ' として移しました。' : '');
      } catch (err) { row.forEach(x => { x.disabled = false; }); b.textContent = text; eile('warn', err.message || String(err)); }
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
      <p class="small">v0.10.0</p>
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

// ===== エイルの部屋（v0.8.0）=====
// 書斎兼ティールームで、エイルとひと息つくための独立した画面。用意した台詞と選択肢を切り替えるだけで、
// GAS・Notion・Drive・Chatwork・外部AIとの通信、録音、会話や滞在の保存はしない。
// 会話の状態は画面内の変数だけで持つ（URL や履歴に載せない）。部屋を出ると消え、再入室時は最初に戻る。
const ROOM_IMG = './img/room_study.png'; // sw.js の SHELL と同じ文字列にする。画像を差し替えるときは sw.js の VERSION を上げる
const ROOM_SAY = {
  start:     { say: 'お疲れさまです。お茶にしますか？\n……今日は、仕事のお話でなくても大丈夫ですよ。',
               choices: [['tea', 'お茶にする', '少し、\nひと息つきましょう'], ['talk', '少し話す', '短いお話を選ぶ'], ['quiet', '静かに過ごす', 'この時間を、\nゆっくりと']] }, // 補助文の \n は折り返し位置の指定
  tea:       { say: 'では、お茶を淹れましょう。何も決めずに、ひと息つく時間もよいものですね。',
               choices: [['talk', '少し話す'], ['quiet', '静かに過ごす'], ['start', '選択肢に戻る']] },
  talk:      { say: '今日の小さな議題です。しおりが見つからないとき、新しい一枚を用意しますか？\nそれとも、探す旅に出ますか？',
               choices: [['talk_new', '新しく用意する'], ['talk_find', '探してみる'], ['start', '選択肢に戻る']] },
  talk_new:  { say: 'では、新しい一枚を。なくした方が出てきたら、次の本の分ですね。',
               choices: [['start', '選択肢に戻る'], ['quiet', '静かに過ごす']] },
  talk_find: { say: 'では、ご一緒に。途中で別の本を読み始めたら、寄り道ということで。',
               choices: [['start', '選択肢に戻る'], ['quiet', '静かに過ごす']] },
  quiet:     { say: '承知しました。では、ここで少しゆっくりしましょう。',
               choices: [['gaze', '眺める'], ['start', '選択肢に戻る']] },
  gaze:      { collapsed: true }, // 会話欄と選択肢を畳む。「会話に戻る」と上部の操作（ホームへ・記録・設定）だけ残す
};
const ROOM_ICON = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M6 10.5V19.5h12v-9"/><path d="M10 19.5v-5h4v5"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5c-1.6-1.4-3.6-2-6-2H4.5v14H6c2.4 0 4.4.6 6 2 1.6-1.4 3.6-2 6-2h1.5v-14H18c-2.4 0-4.4.6-6 2z"/><path d="M12 6.5v14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.6 12l0 .72 2.47.88-.42 1.7-2.63-.39-1.65 2.46-.53.49 1.16 2.39-1.51.91-1.58-2.14-2.91.58-.72-.03-.88 2.5-1.7-.42.39-2.63-2.46-1.65-.49-.53-2.39 1.16-.91-1.51 2.14-1.58L4.4 12l.03-.72-2.5-.88.42-1.7 2.63.39 1.65-2.46.53-.49L6 3.75l1.51-.91 1.58 2.14L12 4.4l.72.03.88-2.5 1.7.42-.39 2.63 2.46 1.65.49.53 2.39-1.16.91 1.51-2.14 1.58z"/><circle cx="12" cy="12" r="3"/></svg>',
};
let roomCleanup = null; // 入室中の片づけ処理（退室時に、背後のUIの操作制限などを必ず戻すため）

function room() {
  if (roomCleanup) roomCleanup(); // 部屋の住所内で再描画された場合に備え、前回分を先に片づける
  titleEl.textContent = 'エイルの部屋';
  const d = new Date();
  const dateText = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + ' ' + '日月火水木金土'[d.getDay()];
  app.innerHTML = `
    <section class="room" id="room" tabindex="-1" aria-label="エイルの部屋">
      <div class="room-stage">
        <img class="room-art" src="${ROOM_IMG}" alt="書斎の机の向こうに座るエイル" width="941" height="1672" decoding="async">
        <div class="room-ui">
          <header class="room-top">
            <button type="button" class="room-btn room-home" data-go="" aria-label="ホームへ">${ROOM_ICON.home}<span>ホームへ</span></button>
            <h2 class="room-title">エイルの部屋<small>Eil's Room</small></h2>
            <div class="room-tools">
              <button type="button" class="room-btn room-tool" data-go="journal" aria-label="記録（ボイスジャーナルへ）">${ROOM_ICON.book}<span>記録</span></button>
              <button type="button" class="room-btn room-tool" data-go="settings" aria-label="設定">${ROOM_ICON.gear}<span>設定</span></button>
            </div>
          </header>
          <div class="room-notice" id="room-notice" role="status" hidden></div>
          <aside class="room-date" id="room-date"><b>${dateText}</b><span class="room-date-long">ここでは、ひと息ついていきませんか。</span><span class="room-date-short">ここで、ひと息。</span></aside>
          <div class="room-bottom">
            <div class="room-talk" id="room-talk">
              <div class="room-name">エイル</div>
              <p class="room-say" id="room-say"></p>
              <div class="room-choices" id="room-choices"></div>
            </div>
            <button type="button" class="room-btn room-return" id="room-return" hidden>会話に戻る</button>
            <p class="room-foot" id="room-foot">「小さな一歩が、きっとどこかへつながっています。」</p>
          </div>
        </div>
      </div>
    </section>`;
  bindGo();
  const talk = $('#room-talk'), say = $('#room-say'), choices = $('#room-choices'), ret = $('#room-return'), dateEl = $('#room-date'), foot = $('#room-foot'), notice = $('#room-notice');

  // --- 台詞と選択肢の切替（状態は変数 state だけ。URL・履歴・端末保存には載せない）---
  let state = 'start';
  function show(id) {
    const st = ROOM_SAY[id] || ROOM_SAY.start;
    state = ROOM_SAY[id] ? id : 'start';
    if (st.collapsed) { // 眺める：会話欄・日付カード・飾り文を畳み、「会話に戻る」を残す
      talk.hidden = true; dateEl.hidden = true; foot.hidden = true; ret.hidden = false;
      ret.focus({ preventScroll: true });
      return;
    }
    talk.hidden = false; dateEl.hidden = false; foot.hidden = false; ret.hidden = true;
    say.textContent = st.say;
    choices.innerHTML = st.choices.map(([to, label, sub]) => `<button type="button" class="room-choice" data-to="${to}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</button>`).join('');
  }
  choices.onclick = e => { const b = e.target.closest('[data-to]'); if (b) show(b.dataset.to); };
  ret.onclick = () => { show('start'); const first = $('.room-choice'); if (first) first.focus({ preventScroll: true }); };
  show('start');

  // --- 背後の既存UI（ヘッダーとエイルの帯）を、部屋の表示中だけ操作・読み上げの対象から外す ---
  const shell = [$('header.top'), $('section.eile')];
  shell.forEach(el => { el.inert = true; el.setAttribute('aria-hidden', 'true'); });
  $('#room').focus({ preventScroll: true });

  // --- 隠れた帯に出る重要な案内（録音の保留など「注意」状態の文言）は、部屋の中にも同じ文で表示する ---
  const mirror = () => {
    if (!eileEl.classList.contains('is-warn')) return;
    notice.textContent = eileSay.textContent; notice.hidden = false;
  };
  const obs = new MutationObserver(mirror);
  obs.observe(eileEl, { attributes: true, attributeFilter: ['class'] });
  obs.observe(eileSay, { childList: true, characterData: true, subtree: true });
  mirror();

  // --- 退室（住所が部屋以外に変わったとき）：操作制限と監視を確実に戻す ---
  const cleanup = () => {
    shell.forEach(el => { el.inert = false; el.removeAttribute('aria-hidden'); });
    obs.disconnect();
    window.removeEventListener('hashchange', onHash);
    if (roomCleanup === cleanup) roomCleanup = null;
  };
  const onHash = () => { if (seg()[0] !== 'room') cleanup(); };
  window.addEventListener('hashchange', onHash);
  roomCleanup = cleanup;
}

// ===== 起動 =====
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
render();
