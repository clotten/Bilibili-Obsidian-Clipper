const $ = (id) => document.getElementById(id);
const state = { course: null, groups: [], providerId: "", folder: "Clippings/Bilibili", settings: {}, autorun: false, running: false, paused: false, current: 0, completed: {}, summaries: {}, failed: [] };

init().catch((error) => log(`初始化失败：${error.message}`));

async function init() {
  const params = new URLSearchParams(location.search);
  const bvid = params.get("bvid") || "";
  state.autorun = params.get("autorun") === "1";
  $("bvidInput").value = bvid;
  bindEvents();
  const settings = await runtime({ type: "get-settings" });
  if (settings?.ok) { state.settings = settings.settings || {}; $("folderInput").value = state.settings.noteFolder || state.folder; }
  await checkObsidianConnection();
  await loadProviders();
  if (bvid) await discover();
  if (state.autorun && state.course && state.providerId) await run();
}

function bindEvents() {
  $("discoverBtn").addEventListener("click", discover);
  $("runBtn").addEventListener("click", run);
  $("pauseBtn").addEventListener("click", () => { state.paused = true; state.running = false; $("pauseBtn").disabled = true; log("已暂停，可稍后点击开始生成继续。"); });
  $("clearCheckpointBtn").addEventListener("click", async () => { if (!state.course) return; await chrome.storage.local.remove(checkpointKey(state.course.bvid)); state.completed = {}; state.summaries = {}; state.failed = []; renderFailed(); log("已清除当前合集断点。"); });
  $("openOptionsBtn").addEventListener("click", () => runtime({ type: "open-options" }));
}

async function loadProviders() {
  const resp = await runtime({ type: "ai-providers-list" });
  const list = resp?.providers || [];
  $("providerSelect").innerHTML = list.length ? list.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.model)}</option>`).join("") : '<option value="">请先在设置中配置 AI</option>';
  state.providerId = list[0]?.id || "";
  $("providerSelect").value = state.providerId;
  $("providerSelect").addEventListener("change", (event) => { state.providerId = event.target.value; });
}

async function discover() {
  const bvid = extractBvid($("bvidInput").value);
  if (!bvid) return log("请输入 B 站视频地址或 BV 号。");
  setBusy(true); log("正在读取合集和分 P 列表...");
  const resp = await runtime({ type: "batch-load-course", bvid });
  if (!resp?.ok) { setBusy(false); return log(`读取失败：${resp?.error || "未知错误"}`); }
  state.course = resp.course; state.groups = makeGroups(state.course.pages); state.completed = {}; state.summaries = {}; state.failed = [];
  const saved = await chrome.storage.local.get(checkpointKey(bvid));
  const checkpoint = saved?.[checkpointKey(bvid)];
  if (checkpoint?.courseTitle === state.course.title) { Object.assign(state, { completed: checkpoint.completed || {}, summaries: checkpoint.summaries || {}, failed: checkpoint.failed || [] }); log(`已恢复断点：完成 ${Object.keys(state.completed).length} 个视频。`); }
  renderCourse(); renderFailed(); setBusy(false);
}

function makeGroups(pages) {
  const groups = [];
  let current = null;
  pages.forEach((page, index) => {
    const number = extractLessonNumber(page.title);
    if (!current || (number === 1 && current.pages.length > 0)) {
      const order = groups.length + 1;
      const label = inferGroupName(page.title, order);
      current = { key: `group-${String(order).padStart(2, "0")}`, name: label, pages: [] };
      groups.push(current);
    }
    current.pages.push(page);
  });
  return groups;
}

function extractLessonNumber(title) {
  const text = String(title || "").replace(/[｜|]/g, "-").trim();
  const match = text.match(/(?:^|[-_—–\s])(?:第)?(\d{1,3})(?:集)?(?=[-_—–\s]|$)/);
  return match ? Number(match[1]) : 0;
}

function inferGroupName(title, order) {
  const text = String(title || "").replace(/[｜|]/g, "-").trim();
  const dayMatch = text.match(/(?:^|[-_—–\s])(day\s*\d+)/i);
  if (dayMatch) return `${String(order).padStart(2, "0")}-${dayMatch[1].replace(/\s+/g, "")}`;
  const parts = text.split(/[-_—–]+/).map((item) => item.trim()).filter(Boolean);
  const numberIndex = parts.findIndex((item) => /^(?:第)?\d{1,3}(?:集)?$/i.test(item));
  const topic = numberIndex >= 0 ? parts[numberIndex + 1] : "";
  return `${String(order).padStart(2, "0")}-${topic || "小合集"}`;
}

function renderCourse() {
  $("courseCard").hidden = false; $("runBtn").disabled = !state.providerId;
  $("courseTitle").textContent = state.course.title || "B 站合集";
  $("courseMeta").textContent = `${state.course.pages.length} 个视频 · ${state.groups.length} 个自动分组 · 作者：${state.course.author || "未知"}`;
  $("groupList").innerHTML = state.groups.map((group, index) => `<div class="group-row"><span>${index + 1}</span><input data-group="${escapeHtml(group.key)}" value="${escapeHtml(group.name)}" /><small>${group.pages.length} 个视频：${escapeHtml(group.pages.slice(0, 2).map((p) => p.title).join("、"))}${group.pages.length > 2 ? "…" : ""}</small></div>`).join("");
  $("groupList").querySelectorAll("input").forEach((input) => input.addEventListener("change", () => { const group = state.groups.find((item) => item.key === input.dataset.group); if (group) group.name = input.value.trim() || group.key; }));
}

async function run() {
  if (!state.course || !state.providerId || state.running) return;
  if (!(await checkObsidianConnection())) { log("无法开始：请保持 Obsidian 打开，并完成 Local REST API 配置。"); return; }
  log("正在测试 AI 模型和接口地址...");
  const aiReady = await runtime({ type: "batch-ai-preflight", providerId: state.providerId }).catch((error) => ({ ok: false, error: error.message }));
  if (!aiReady?.ok) { log(`AI 配置不可用，任务已停止：${aiReady?.error || "未知错误"}`); return; }
  log("AI 连接正常，开始处理合集。");
  state.folder = $("folderInput").value.trim().replace(/\/+$/g, "") || "Clippings/Bilibili"; state.paused = false; state.running = true; $("progressCard").hidden = false; $("pauseBtn").disabled = false;
  const all = state.course.pages; $("progressBar").max = all.length; $("progressBar").value = Object.keys(state.completed).length;
  for (let index = 0; index < all.length; index += 1) { if (!state.running || state.paused) break; const page = all[index]; state.current = index + 1; if (state.completed[page.cid] && state.summaries[page.cid]?.summary) { updateProgress(index + 1, `跳过已完成：${page.title}`); continue; } try { await processPage(page, index + 1); } catch (error) { addFailed(page, error?.message || "处理失败"); } await saveCheckpoint(); }
  if (state.running && !state.paused) { await buildAggregates(); state.running = false; log(`全部处理完成。笔记已自动写入当前 Obsidian 仓库：${state.folder}/${sanitize(state.course.title)}`); }
  else if (state.paused) log("已暂停，点击“开始生成”可继续。");
  renderFailed();
}

async function processPage(page, number) {
  const group = groupFor(page);
  const path = notePath(state.course.title, group.name, videoFileName(page));
  const existing = await readNote(path);
  if (existing.exists) {
    state.completed[page.cid] = true;
    if (!state.summaries[page.cid]?.summary) state.summaries[page.cid] = { page, summary: stripNoteMetadata(existing.content), groupKey: group.key };
    removeFailed(page);
    log(`Obsidian 已存在，跳过：${page.title}`);
    return;
  }
  updateProgress(number, `抓取字幕：${page.title}`); const loaded = await runtime({ type: "batch-load-page", bvid: page.bvid || state.course.bvid, cid: page.cid, pageIndex: page.page });
  if (!loaded?.ok) { addFailed(page, `字幕读取失败：${loaded?.error || "无法读取字幕"}`); return; }
  const subtitle = clip(loaded.page.subtitleMarkdown, 50000); const prompt = `请把下面这期课程视频整理成适合 Obsidian 复习的 Markdown 学习笔记。必须严格使用以下一级结构：\n## 本节目标\n## 核心知识点\n## 操作步骤与代码示例\n## 易错点\n## 本节总结\n## 练习题\n## 时间戳索引\n要求：不要写视频之外的内容；保留重要时间戳；没有代码时明确写“本节无代码示例”；信息不足写“字幕未提及”。只输出笔记正文。\n\n视频标题：${loaded.page.title}\n\n字幕：\n${subtitle}`;
  updateProgress(number, `AI 总结：${page.title}`); const ai = await runtime({ type: "batch-ai-complete", providerId: state.providerId, systemPrompt: "你是严谨的课程笔记整理助手，必须忠实于字幕，不得编造。输出简洁、结构清晰的 Markdown。", prompt });
  if (!ai?.ok) { addFailed(page, `AI 总结失败：${ai?.error || "未知错误"}`); return; }
  const content = videoNote(loaded.page, ai.content); const written = await writeNote(path, content);
  if (!written?.ok) { addFailed(page, written?.error || "写入 Obsidian 失败"); return; }
  state.completed[page.cid] = true; state.summaries[page.cid] = { page, summary: ai.content, groupKey: group.key }; removeFailed(page); log(`完成 ${number}: ${page.title}`);
}

async function buildAggregates() {
  for (const group of state.groups) { const items = group.pages.map((page) => state.summaries[page.cid]).filter(Boolean); if (!items.length) continue; updateProgress(state.course.pages.length, `合成小合集：${group.name}`); const source = items.map((item) => `## ${item.page.title}\n\n${clip(item.summary, 12000)}`).join("\n\n"); const ai = await runtime({ type: "batch-ai-complete", providerId: state.providerId, systemPrompt: "你是课程主编，请只根据输入的多篇视频笔记合成完整教程，不得补充未提供的事实。", prompt: `请将以下同一小合集的视频笔记合成为一篇可以连续阅读的完整教程，同时提供知识点目录。输出结构：学习目标、知识点目录、完整教程、易错点、综合练习。单篇笔记链接由程序另行生成，不要虚构链接。只输出 Markdown 正文。\n\n${clip(source, 60000)}` }); if (ai?.ok) await writeNote(notePath(state.course.title, group.name, "00-小合集完整教程"), chapterNote(group, ai.content)); else addFailed({ title: group.name, page: 0, url: "" }, ai?.error || "小合集合成失败"); }
  const links = state.groups.map((group) => `- [[${group.name}/00-小合集完整教程|${group.name}]]`).join("\n"); const failed = state.failed.length ? `\n\n## 失败清单\n\n${state.failed.map((item) => `- ${item.title}：${item.reason}`).join("\n")}` : ""; await writeNote(notePath(state.course.title, "", "00-课程总目录"), `---\ntitle: ${state.course.title}\ntags: [bilibili, 学习笔记]\n---\n\n# ${state.course.title}\n\n作者：${state.course.author || "未知"}\n\n## 小合集\n\n${links}${failed}`); if (state.failed.length) await writeNote(notePath(state.course.title, "", "00-失败清单"), `# ${state.course.title} - 失败清单\n\n${state.failed.map((item) => `- **${item.title}**：${item.reason}`).join("\n")}`); }

function groupFor(page) { return state.groups.find((group) => group.pages.some((item) => item.cid === page.cid)) || { key: "未分类", name: "未分类", pages: [] }; }
function videoNote(page, body) { return `---\ntitle: ${page.title}\nsource: ${page.url}\nbvid: ${page.bvid}\ncid: ${page.cid}\ntags: [bilibili, 学习笔记]\n---\n\n# ${page.title}\n\n来源：[B 站视频](${page.url})\n\n${body.trim()}\n`; }
function chapterNote(group, body) { return `---\ntitle: ${group.name}\ntags: [bilibili, 学习笔记, 章节总结]\n---\n\n# ${group.name}\n\n${body.trim()}\n\n## 视频笔记索引\n\n${group.pages.map((page) => `- [[${videoFileName(page)}|${page.title}]]`).join("\n")}\n`; }
function notePath(course, group, name) { return [state.folder, sanitize(course), group && sanitize(group), `${sanitize(name)}.md`].filter(Boolean).join("/"); }
async function writeNote(filepath, content) { return runtime({ type: "write-obsidian-note", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath, content }).then((resp) => { if (resp?.ok) return resp; return resp; }); }
async function noteExists(filepath) { const resp = await runtime({ type: "obsidian-note-exists", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath }); return Boolean(resp?.ok && resp.exists); }
async function readNote(filepath) { const resp = await runtime({ type: "read-obsidian-note", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath }); return { exists: Boolean(resp?.ok && resp.exists), content: String(resp?.content || "") }; }
function stripNoteMetadata(content) { return String(content || "").replace(/^---[\s\S]*?---\s*/m, "").slice(0, 20000); }
function videoFileName(page) { const order = Number(page.index || page.page || 0) || 0; return `${String(order).padStart(3, "0")}-${page.title}`; }
function addFailed(page, reason) { const key = `${page.cid || page.title}`; if (!state.failed.some((item) => item.key === key)) state.failed.push({ key, title: page.title, page: page.page, url: page.url, reason: String(reason) }); log(`失败：${page.title}（${reason}）`); }
function removeFailed(page) { const key = `${page.cid || page.title}`; state.failed = state.failed.filter((item) => item.key !== key); }
function renderFailed() { $("failedCard").hidden = !state.failed.length; $("failedList").innerHTML = state.failed.map((item) => `<div class="failed-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.reason)}${item.url ? ` · <a href="${escapeHtml(item.url)}" target="_blank">打开视频</a>` : ""}</span></div>`).join(""); }
function updateProgress(value, text) { $("progressBar").value = value; $("progressText").textContent = text; $("progressCount").textContent = `${Math.min(value, state.course?.pages.length || value)}/${state.course?.pages.length || value}`; }
function setBusy(value) { $("discoverBtn").disabled = value; $("bvidInput").disabled = value; }
function log(text) { $("log").textContent += `${new Date().toLocaleTimeString()} ${text}\n`; $("log").scrollTop = $("log").scrollHeight; }
async function saveCheckpoint() { if (!state.course) return; await chrome.storage.local.set({ [checkpointKey(state.course.bvid)]: { courseTitle: state.course.title, completed: state.completed, summaries: state.summaries, failed: state.failed, updatedAt: Date.now() } }); }
function checkpointKey(bvid) { return `boc_batch_checkpoint_${bvid}`; }
function extractBvid(value) { const text = String(value || "").trim(); return text.match(/BV[0-9A-Za-z]+/i)?.[0] || ""; }
function sanitize(value) { return String(value || "未命名").replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "未命名"; }
function clip(value, max) { const text = String(value || ""); return text.length > max ? `${text.slice(0, max)}\n\n（内容过长，已截断）` : text; }
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function checkObsidianConnection() { const node = $("obsidianStatus"); const baseUrl = String(state.settings?.obsidianApiBaseUrl || "").trim(); const apiKey = String(state.settings?.obsidianApiKey || "").trim(); if (!baseUrl || !apiKey) { if (node) node.textContent = "⚠ Obsidian 尚未配置：请点击右上角“设置”填写 Local REST API 地址和 Key。"; return false; } const resp = await runtime({ type: "test-obsidian-connection", baseUrl, apiKey }).catch((error) => ({ ok: false, error: error.message })); if (node) { node.textContent = resp?.ok ? "✓ Obsidian 已连接：生成的笔记会自动导入当前仓库。" : `⚠ Obsidian 连接失败：${resp?.error || "请确认 Obsidian 已打开"}`; node.style.color = resp?.ok ? "#15803d" : "#b45309"; } return Boolean(resp?.ok); }
function runtime(message) { return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (resp) => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(resp); })); }
