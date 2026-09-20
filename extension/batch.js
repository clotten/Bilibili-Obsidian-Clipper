const $ = (id) => document.getElementById(id);
const state = { course: null, groups: [], providerId: "", folder: "Clippings/Bilibili", settings: {}, autorun: false, running: false, paused: false, current: 0, runTotal: 0, activeRequestId: "", completed: {}, summaries: {}, failed: [] };

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
  if (state.course && state.providerId) log("合集已读取，请选择小合集后点击“开始生成”。");
}

function bindEvents() {
  $("discoverBtn").addEventListener("click", discover);
  $("runBtn").addEventListener("click", run);
  $("startBtn").addEventListener("click", run);
  $("aiGroupBtn").addEventListener("click", aiSuggestGroups);
  $("addGroupBtn").addEventListener("click", addManualGroup);
  $("aggregateBtn").addEventListener("click", aggregateOnly);
  $("selectAllGroupsBtn").addEventListener("click", () => { state.groups.forEach((group) => { group.selected = true; group.aggregateSelected = true; }); renderCourse(); saveCheckpoint(); });
  $("selectNoGroupsBtn").addEventListener("click", () => { state.groups.forEach((group) => { group.selected = false; group.aggregateSelected = false; }); renderCourse(); saveCheckpoint(); });
  $("pauseBtn").addEventListener("click", () => { if (!state.running) return; state.paused = true; $("pauseBtn").disabled = true; cancelActiveBatchRequest(); log("正在暂停：取消当前 AI 请求，完成收尾后停止。"); });
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
  if (checkpoint?.courseTitle === state.course.title) { Object.assign(state, { completed: checkpoint.completed || {}, summaries: checkpoint.summaries || {}, failed: checkpoint.failed || [] }); state.groups = restoreGroups(checkpoint.groups, state.course.pages) || state.groups; log(`已恢复断点：完成 ${Object.keys(state.completed).length} 个视频。`); }
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
      current = { key: `group-${String(order).padStart(2, "0")}`, name: label, pages: [], selected: true, aggregateSelected: true };
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
  $("groupList").innerHTML = state.groups.map((group, index) => `<div class="group-row"><label class="group-select" title="处理此组内视频"><input type="checkbox" data-group-select="${escapeHtml(group.key)}" ${group.selected !== false ? "checked" : ""} /></label><label class="group-select" title="合成此小合集教程"><input type="checkbox" data-group-aggregate="${escapeHtml(group.key)}" ${group.aggregateSelected !== false ? "checked" : ""} /></label><span>${index + 1}</span><input data-group="${escapeHtml(group.key)}" value="${escapeHtml(group.name)}" /><small>${group.pages.length} 个视频：${escapeHtml(group.pages.slice(0, 2).map((p) => p.title).join("、"))}${group.pages.length > 2 ? "…" : ""}${group.reason ? `<br>AI 建议：${escapeHtml(group.reason)}` : ""}</small><div class="group-generate-actions"><button class="secondary" data-generate-group="${escapeHtml(group.key)}" type="button">生成教程</button><button class="secondary" data-regenerate-group="${escapeHtml(group.key)}" type="button">重新生成</button><button class="secondary danger" data-delete-group="${escapeHtml(group.key)}" type="button">删除组</button></div></div>`).join("");
  $("groupList").querySelectorAll("input[data-group-select]").forEach((input) => input.addEventListener("change", () => { const group = state.groups.find((item) => item.key === input.dataset.groupSelect); if (group) { group.selected = input.checked; saveCheckpoint(); } }));
  $("groupList").querySelectorAll("input[data-group-aggregate]").forEach((input) => input.addEventListener("change", () => { const group = state.groups.find((item) => item.key === input.dataset.groupAggregate); if (group) { group.aggregateSelected = input.checked; saveCheckpoint(); } }));
  $("groupList").querySelectorAll("input[data-group]").forEach((input) => input.addEventListener("change", () => { const group = state.groups.find((item) => item.key === input.dataset.group); if (group) { group.name = input.value.trim() || group.key; renderCourse(); saveCheckpoint(); } }));
  $("groupList").querySelectorAll("button[data-generate-group]").forEach((button) => button.addEventListener("click", () => aggregateGroups([state.groups.find((group) => group.key === button.dataset.generateGroup)].filter(Boolean), false)));
  $("groupList").querySelectorAll("button[data-regenerate-group]").forEach((button) => button.addEventListener("click", () => aggregateGroups([state.groups.find((group) => group.key === button.dataset.regenerateGroup)].filter(Boolean), true)));
  $("groupList").querySelectorAll("button[data-delete-group]").forEach((button) => button.addEventListener("click", () => deleteManualGroup(button.dataset.deleteGroup)));
  renderVideoAssignments();
}

function renderVideoAssignments() {
  const node = $("videoAssignmentList");
  if (!node || !state.course) return;
  node.innerHTML = state.course.pages.map((page, index) => `<div class="video-assignment-row"><span>${index + 1}</span><span class="video-assignment-title">${escapeHtml(page.title)}</span><select data-page-cid="${escapeHtml(page.cid)}">${state.groups.map((group) => `<option value="${escapeHtml(group.key)}" ${group.pages.some((item) => item.cid === page.cid) ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("")}</select></div>`).join("");
  node.querySelectorAll("select[data-page-cid]").forEach((select) => select.addEventListener("change", () => movePageToGroup(select.dataset.pageCid, select.value)));
}

function movePageToGroup(cid, targetKey) {
  const page = state.course?.pages.find((item) => String(item.cid) === String(cid));
  const target = state.groups.find((group) => group.key === targetKey);
  if (!page || !target) return;
  state.groups.forEach((group) => { group.pages = group.pages.filter((item) => item.cid !== page.cid); });
  target.pages.push(page);
  renderCourse();
  saveCheckpoint();
}

function addManualGroup() {
  const order = state.groups.length + 1;
  state.groups.push({ key: `group-${Date.now().toString(36)}`, name: `${String(order).padStart(2, "0")}-新小合集`, pages: [], selected: true, aggregateSelected: true });
  renderCourse();
  saveCheckpoint();
}

function deleteManualGroup(groupKey) {
  if (state.groups.length <= 1) return log("至少需要保留一个小合集。");
  const index = state.groups.findIndex((group) => group.key === groupKey);
  if (index < 0) return;
  const [removed] = state.groups.splice(index, 1);
  let fallback = state.groups.find((group) => /未分类/.test(group.name));
  if (!fallback) {
    fallback = { key: `group-unclassified-${Date.now().toString(36)}`, name: `${String(state.groups.length + 1).padStart(2, "0")}-未分类`, pages: [], selected: true, aggregateSelected: true };
    state.groups.push(fallback);
  }
  fallback.pages.push(...removed.pages);
  renderCourse();
  saveCheckpoint();
}

async function aiSuggestGroups() {
  if (!state.course || state.running || state.activeRequestId) return;
  if (!state.providerId) return log("请先配置 AI 平台。");
  const titles = state.course.pages.map((page, index) => `${index + 1}. ${page.title}`).join("\n");
  log("正在让 AI 根据视频标题提出分组建议（不会自动开始生成）...");
  $("aiGroupBtn").disabled = true;
  let result;
  try { result = await runBatchAiRequest({ providerId: state.providerId, systemPrompt: "你是课程目录整理助手，只能根据视频标题进行主题分组，不要编造视频内容。", prompt: `请把下面的视频标题按连续课程主题分成若干小合集。返回严格 JSON，不要 Markdown 代码块：{"groups":[{"name":"HTML基础","start":1,"end":16,"reason":"标题集中在HTML标签和样式"}]}。start/end 是原列表的 1-based 连续区间，必须覆盖所有视频且不能重叠；如果无法判断，也要按相邻主题给出合理建议。\n\n${titles}` }); }
  catch (error) { log(`AI 分组失败：${error.message}`); return; }
  finally { $("aiGroupBtn").disabled = false; }
  if (!result?.ok) { log(`AI 分组失败：${result?.error || "未知错误"}`); return; }
  const suggestion = parseAiGroups(result.content);
  if (!suggestion.length) { log("AI 没有返回有效分组，保留当前分组。"); return; }
  applyGroupSuggestion(suggestion);
  log(`AI 已提出 ${suggestion.length} 个分组建议，请在页面上人工调整后再开始生成。`);
}

function parseAiGroups(content) {
  const text = String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let data;
  try { data = JSON.parse(text); } catch { const match = text.match(/\{[\s\S]*\}/); try { data = match ? JSON.parse(match[0]) : null; } catch { data = null; } }
  return Array.isArray(data?.groups) ? data.groups.map((item) => ({ name: String(item.name || "小合集").trim(), start: Number(item.start), end: Number(item.end), reason: String(item.reason || "").trim() })).filter((item) => item.start >= 1 && item.end >= item.start) : [];
}

function applyGroupSuggestion(suggestion) {
  const pages = state.course.pages;
  const groups = suggestion.map((item, index) => ({ key: `group-ai-${Date.now().toString(36)}-${index}`, name: `${String(index + 1).padStart(2, "0")}-${item.name}`, pages: [], selected: true, aggregateSelected: true, reason: item.reason }));
  const assigned = new Set();
  groups.forEach((group, index) => { const item = suggestion[index]; for (let i = Math.max(1, item.start); i <= Math.min(pages.length, item.end); i += 1) { const page = pages[i - 1]; if (!assigned.has(page.cid)) { group.pages.push(page); assigned.add(page.cid); } } });
  const rest = pages.filter((page) => !assigned.has(page.cid));
  if (rest.length) groups.push({ key: `group-unclassified-${Date.now().toString(36)}`, name: `${String(groups.length + 1).padStart(2, "0")}-未分类`, pages: rest, selected: true, aggregateSelected: true });
  state.groups = groups;
  renderCourse();
  saveCheckpoint();
}

async function run() {
  if (!state.course || !state.providerId || state.running) return;
  state.folder = $("folderInput").value.trim().replace(/\/+$/g, "") || "Clippings/Bilibili";
  const selectedGroups = state.groups.filter((group) => group.selected !== false);
  if (!selectedGroups.length) { log("请至少选择一个小合集。没有选择的小合集不会生成，也不会调用 AI。"); return; }
  state.paused = false;
  state.running = true;
  setStartButton(true);
  $("progressCard").hidden = false;
  $("pauseBtn").disabled = true;
  setRunButton(true);
  updateProgress(Object.keys(state.completed).length, "正在检查 Obsidian 连接...");
  if (!(await checkObsidianConnection())) { log("无法开始：请保持 Obsidian 打开，并完成 Local REST API 配置。"); finishRun(); return; }
  updateProgress(Object.keys(state.completed).length, "正在检查 AI 配置...");
  const aiReady = await checkAiConnection();
  if (!aiReady?.ok) { log(`AI 配置不可用，任务已停止：${aiReady?.error || "未知错误"}`); finishRun(); return; }
  log("AI 连接正常，开始处理合集。");
  $("pauseBtn").disabled = false;
  const all = selectedGroups.flatMap((group) => group.pages); state.runTotal = all.length; $("progressBar").max = all.length; $("progressBar").value = Math.min(Object.keys(state.completed).length, all.length);
  for (let index = 0; index < all.length; index += 1) { if (!state.running || state.paused) break; const page = all[index]; state.current = index + 1; if (state.completed[page.cid] && state.summaries[page.cid]?.summary && state.summaries[page.cid]?.hasSubtitle) { updateProgress(index + 1, `跳过已完成：${page.title}`); continue; } try { await processPage(page, index + 1); } catch (error) { addFailed(page, error?.message || "处理失败"); } await saveCheckpoint(); }
  if (state.running && !state.paused) { await writeCourseIndex(); log(`视频笔记处理完成。需要小合集教程时，请点击“合成已勾选小合集”。笔记目录：${state.folder}/${sanitize(state.course.title)}`); }
  else if (state.paused) log("已暂停，点击“开始生成”可继续。");
  state.running = false;
  setRunButton(false);
  $("pauseBtn").disabled = true;
  setStartButton(false);
  renderFailed();
}

function finishRun() {
  state.running = false;
  state.paused = false;
  setRunButton(false);
  $("pauseBtn").disabled = true;
  setStartButton(false);
}

function setRunButton(busy) {
  const button = $("runBtn");
  button.disabled = busy || !state.providerId;
  button.textContent = busy ? "处理中..." : "一键全自动生成";
}

function setStartButton(busy) { const button = $("startBtn"); if (!button) return; button.disabled = busy; button.textContent = busy ? "生成中…" : "开始/继续生成"; }

async function aggregateOnly() {
  if (!state.course || !state.providerId || state.running) return;
  const selected = state.groups.filter((group) => group.aggregateSelected !== false);
  if (!selected.length) return log("请至少勾选一个需要合成教程的小合集（每组第二个复选框）。");
  await aggregateGroups(selected, false);
}

async function aggregateGroups(selected, force) {
  if (!state.course || !state.providerId || state.running || !selected.length) return;
  state.folder = $("folderInput").value.trim().replace(/\/+$/g, "") || "Clippings/Bilibili";
  state.paused = false;
  state.running = true;
  $("progressCard").hidden = false;
  $("pauseBtn").disabled = false;
  setRunButton(true);
  setStartButton(true);
  $("aggregateBtn").disabled = true;
  try {
    updateProgress(0, "正在检查 Obsidian 连接...");
    if (!(await checkObsidianConnection())) {
      log("无法合成：请保持 Obsidian 打开，并完成 Local REST API 配置。");
      return;
    }
    updateProgress(0, "正在检查 AI 配置...");
    const aiReady = await checkAiConnection();
    if (!aiReady?.ok) {
      log(`AI 配置不可用，小合集合成已停止：${aiReady?.error || "未知错误"}`);
      return;
    }
    log(`开始${force ? "重新" : ""}合成 ${selected.length} 个小合集。`);
    await buildAggregates(selected, force);
    if (state.paused) log("小合集合成已暂停，可再次点击“合成已勾选小合集”继续。"); else log("已完成所选小合集教程合成。");
  } catch (error) {
    log(`小合集合成中断：${error?.message || "未知错误"}`);
  } finally {
    state.running = false;
    $("pauseBtn").disabled = true;
    $("aggregateBtn").disabled = false;
    setRunButton(false);
    setStartButton(false);
    renderFailed();
  }
}

async function processPage(page, number) {
  const group = groupFor(page);
  const path = notePath(state.course.title, group.name, videoFileName(page));
  const existing = await readNote(path);
  if (existing.exists && hasSubtitleAttachment(existing.content)) {
    state.completed[page.cid] = true;
    if (!state.summaries[page.cid]?.summary) state.summaries[page.cid] = { page, summary: stripNoteMetadata(existing.content), groupKey: group.key, hasSubtitle: true };
    removeFailed(page);
    log(`Obsidian 已存在，跳过：${page.title}`);
    return;
  }
  const subtitleOnly = existing.exists;
  updateProgress(number, `抓取字幕：${page.title}`); const loaded = await runtime({ type: "batch-load-page", bvid: page.bvid || state.course.bvid, cid: page.cid, pageIndex: page.page });
  if (!loaded?.ok) { addFailed(page, `字幕读取失败：${loaded?.error || "无法读取字幕"}`); return; }
  if (!state.running || state.paused) return;
  const subtitleText = subtitleToSrt(loaded.page.subtitleBody);
  const subtitlePath = subtitleFilePath(state.course.title, group.name, videoFileName(page));
  const subtitleWritten = await writeNote(subtitlePath, subtitleText);
  if (!subtitleWritten?.ok) { addFailed(page, `字幕文件写入失败：${subtitleWritten?.error || "无法写入 Obsidian"}`); return; }
  if (subtitleOnly) {
    const content = appendSubtitleToExisting(existing.content, subtitlePath, subtitleText);
    const written = await writeNote(path, content);
    if (!written?.ok) { addFailed(page, written?.error || "写入 Obsidian 失败"); return; }
    state.completed[page.cid] = true;
    state.summaries[page.cid] = { page, summary: stripNoteMetadata(existing.content), groupKey: group.key, hasSubtitle: true, subtitlePath };
    removeFailed(page);
    log(`已补齐字幕：${page.title}`);
    return;
  }
  const subtitle = clip(loaded.page.subtitleMarkdown, 50000); const prompt = `请把下面这期课程视频整理成适合 Obsidian 复习的 Markdown 学习笔记。必须严格使用以下一级结构：\n## 本节目标\n## 核心知识点\n## 操作步骤与代码示例\n## 易错点\n## 本节总结\n## 练习题\n## 时间戳索引\n要求：不要写视频之外的内容；保留重要时间戳；没有代码时明确写“本节无代码示例”；信息不足写“字幕未提及”。只输出笔记正文。\n\n视频标题：${loaded.page.title}\n\n字幕：\n${subtitle}`;
  updateProgress(number, `AI 总结：${page.title}`); const ai = await runBatchAiRequest({ providerId: state.providerId, systemPrompt: "你是严谨的课程笔记整理助手，必须忠实于字幕，不得编造。输出简洁、结构清晰的 Markdown。", prompt });
  if (ai?.aborted || state.paused) return;
  if (!ai?.ok) { addFailed(page, `AI 总结失败：${ai?.error || "未知错误"}`); return; }
  const content = videoNote(loaded.page, ai.content, subtitlePath, subtitleText); const written = await writeNote(path, content);
  if (!written?.ok) { addFailed(page, written?.error || "写入 Obsidian 失败"); return; }
  state.completed[page.cid] = true; state.summaries[page.cid] = { page, summary: ai.content, groupKey: group.key, hasSubtitle: true, subtitlePath }; removeFailed(page); log(`完成 ${number}: ${page.title}（含字幕）`);
}

async function buildAggregates(targetGroups = state.groups.filter((item) => item.aggregateSelected !== false), force = false) {
  const includeSubtitles = $("aggregateIncludeSubtitles")?.checked === true;
  const extraPrompt = $("aggregatePrompt")?.value.trim() || "";
  for (const group of targetGroups) {
    if (!state.running || state.paused) break;
    if (!group.pages.length) { log(`跳过空的小合集：${group.name}`); continue; }
    const items = [];
    for (const page of group.pages) {
      let item = state.summaries[page.cid];
      if (!item?.summary) {
        const note = await readNote(notePath(state.course.title, group.name, videoFileName(page)));
        if (note.exists && note.content) item = { page, summary: stripNoteMetadata(note.content), groupKey: group.key };
      }
      if (item?.summary) items.push({ ...item, page });
    }
    if (items.length !== group.pages.length) {
      log(`跳过小合集：${group.name}（还有 ${group.pages.length - items.length} 个视频没有笔记，请先生成视频笔记）`);
      continue;
    }
    const aggregatePath = notePath(state.course.title, group.name, "00-小合集完整教程");
    const existing = await readNote(aggregatePath);
    if (!force && existing.exists && String(existing.content || "").trim()) {
      log(`小合集已存在，跳过 AI 合成：${group.name}`);
      continue;
    }
    updateProgress(state.course.pages.length, `合成小合集：${group.name}`);
    const source = await buildAggregateSource(items, includeSubtitles, group);
    const ai = await runBatchAiRequest({
      type: "batch-ai-complete",
      providerId: state.providerId,
      systemPrompt: "你是课程主编，请只根据输入的多篇视频笔记合成完整教程，不得补充未提供的事实。",
      prompt: `请将以下同一小合集的视频笔记合成为一篇可以连续阅读的完整教程，同时提供知识点目录。输出结构：学习目标、知识点目录、完整教程、易错点、综合练习。单篇笔记链接由程序另行生成，不要虚构链接。只输出 Markdown 正文。${extraPrompt ? `\n额外要求：${extraPrompt}` : ""}\n\n${clip(source, includeSubtitles ? 90000 : 60000)}`
    });
    if (ai?.aborted || state.paused) break;
    if (ai?.ok) {
      const written = await writeNote(aggregatePath, chapterNote(group, ai.content));
      if (!written?.ok) addFailed({ title: group.name, page: 0, url: "" }, written?.error || "小合集写入失败");
    } else {
      addFailed({ title: group.name, page: 0, url: "" }, ai?.error || "小合集合成失败");
    }
  }
  await writeCourseIndex();
}

async function writeCourseIndex() {
  const sections = state.groups.map((group) => `## ${group.name}\n\n- [[${group.name}/00-小合集完整教程|小合集完整教程]]\n${group.pages.map((page) => `- [[${group.name}/${videoFileName(page)}|${page.title}]]`).join("\n")}`).join("\n\n");
  const failed = state.failed.length ? `\n\n## 失败清单\n\n${state.failed.map((item) => `- ${item.title}：${item.reason}`).join("\n")}` : "";
  await writeNote(notePath(state.course.title, "", "00-课程总目录"), `---\ntitle: ${state.course.title}\ntags: [bilibili, 学习笔记]\n---\n\n# ${state.course.title}\n\n作者：${state.course.author || "未知"}\n\n${sections}${failed}`);
  if (state.failed.length) await writeNote(notePath(state.course.title, "", "00-失败清单"), `# ${state.course.title} - 失败清单\n\n${state.failed.map((item) => `- **${item.title}**：${item.reason}`).join("\n")}`);
}

async function buildAggregateSource(items, includeSubtitles, group) {
  const parts = [];
  for (const item of items) {
    let part = `## ${item.page.title}\n\n${clip(String(item.summary).split(/\n## 原始字幕\b/)[0], 12000)}`;
    if (includeSubtitles) {
      const subtitlePath = item.subtitlePath || subtitleFilePath(state.course.title, group.name, videoFileName(item.page));
      const subtitle = await readNote(subtitlePath);
      if (subtitle.exists && subtitle.content) part += `\n\n### 原始字幕\n\n${clip(subtitle.content, 12000)}`;
    }
    parts.push(part);
  }
  return parts.join("\n\n");
}

function groupFor(page) { return state.groups.find((group) => group.pages.some((item) => item.cid === page.cid)) || { key: "未分类", name: "未分类", pages: [] }; }
function videoNote(page, body, subtitlePath, subtitleText) { const subtitleName = String(subtitlePath || "").split("/").pop() || "字幕.srt"; const safeSubtitle = String(subtitleText || "（字幕为空）").replaceAll("```", "` ` `"); return `---\ntitle: ${page.title}\nsource: ${page.url}\nbvid: ${page.bvid}\ncid: ${page.cid}\ntags: [bilibili, 学习笔记]\n---\n\n# ${page.title}\n\n来源：[B 站视频](${page.url})\n\n${body.trim()}\n\n---\n\n## 原始字幕\n\n> 字幕文件：[${subtitleName}](${subtitleName})\n\n<details>\n<summary>展开完整字幕</summary>\n\n\`\`\`srt\n${safeSubtitle}\n\`\`\`\n\n</details>\n`;
}
function appendSubtitleToExisting(content, subtitlePath, subtitleText) { return `${String(content || "").replace(/\s*$/, "")}\n\n---\n\n## 原始字幕\n\n> 字幕文件：[${String(subtitlePath || "").split("/").pop() || "字幕.srt"}](${String(subtitlePath || "").split("/").pop() || "字幕.srt"})\n\n<details>\n<summary>展开完整字幕</summary>\n\n\`\`\`srt\n${String(subtitleText || "（字幕为空）").replaceAll("```", "` ` `")}\n\`\`\`\n\n</details>\n`; }
function chapterNote(group, body) { return `---\ntitle: ${group.name}\ntags: [bilibili, 学习笔记, 章节总结]\n---\n\n# ${group.name}\n\n${body.trim()}\n\n## 视频笔记索引\n\n${group.pages.map((page) => `- [[${videoFileName(page)}|${page.title}]]`).join("\n")}\n`; }
function notePath(course, group, name) { return [state.folder, sanitize(course), group && sanitize(group), `${sanitize(name)}.md`].filter(Boolean).join("/"); }
function subtitleFilePath(course, group, name) { return [state.folder, sanitize(course), group && sanitize(group), `${sanitize(name)}.srt`].filter(Boolean).join("/"); }
async function writeNote(filepath, content) { return runtime({ type: "write-obsidian-note", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath, content }).then((resp) => { if (resp?.ok) return resp; return resp; }); }
async function noteExists(filepath) { const resp = await runtime({ type: "obsidian-note-exists", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath }); return Boolean(resp?.ok && resp.exists); }
async function readNote(filepath) { const resp = await runtime({ type: "read-obsidian-note", baseUrl: state.settings?.obsidianApiBaseUrl || undefined, apiKey: state.settings?.obsidianApiKey || undefined, filepath }); return { exists: Boolean(resp?.ok && resp.exists), content: String(resp?.content || "") }; }
function stripNoteMetadata(content) { return String(content || "").replace(/^---[\s\S]*?---\s*/m, "").slice(0, 20000); }
function hasSubtitleAttachment(content) { return /## 原始字幕[\s\S]*字幕文件：/i.test(String(content || "")); }
function subtitleToSrt(body) { return (Array.isArray(body) ? body : []).filter((item) => String(item?.content || "").trim()).map((item, index) => `${index + 1}\n${formatSrtTime(item?.from)} --> ${formatSrtTime(item?.to)}\n${String(item?.content || "").trim()}\n`).join("\n"); }
function formatSrtTime(seconds) { const safe = Math.max(0, Number(seconds) || 0); const hours = Math.floor(safe / 3600); const minutes = Math.floor((safe % 3600) / 60); const wholeSeconds = Math.floor(safe % 60); const millis = Math.floor((safe - Math.floor(safe)) * 1000); return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`; }
function videoFileName(page) { const order = Number(page.index || page.page || 0) || 0; return `${String(order).padStart(3, "0")}-${page.title}`; }
function addFailed(page, reason) { const key = `${page.cid || page.title}`; if (!state.failed.some((item) => item.key === key)) state.failed.push({ key, title: page.title, page: page.page, url: page.url, reason: String(reason) }); log(`失败：${page.title}（${reason}）`); }
function removeFailed(page) { const key = `${page.cid || page.title}`; state.failed = state.failed.filter((item) => item.key !== key); }
function renderFailed() { $("failedCard").hidden = !state.failed.length; $("failedList").innerHTML = state.failed.map((item) => `<div class="failed-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.reason)}${item.url ? ` · <a href="${escapeHtml(item.url)}" target="_blank">打开视频</a>` : ""}</span></div>`).join(""); }
function updateProgress(value, text) { const total = state.runTotal || state.course?.pages.length || value; $("progressBar").value = Math.min(value, total); $("progressText").textContent = text; $("progressCount").textContent = `${Math.min(value, total)}/${total}`; }
function setBusy(value) { $("discoverBtn").disabled = value; $("bvidInput").disabled = value; }
function log(text) { $("log").textContent += `${new Date().toLocaleTimeString()} ${text}\n`; $("log").scrollTop = $("log").scrollHeight; }
async function saveCheckpoint() { if (!state.course) return; await chrome.storage.local.set({ [checkpointKey(state.course.bvid)]: { courseTitle: state.course.title, completed: state.completed, summaries: state.summaries, failed: state.failed, groups: state.groups.map((group) => ({ key: group.key, name: group.name, reason: group.reason || "", selected: group.selected !== false, aggregateSelected: group.aggregateSelected !== false, pageCids: group.pages.map((page) => String(page.cid)) })), updatedAt: Date.now() } }); }
function restoreGroups(savedGroups, pages) { if (!Array.isArray(savedGroups) || !savedGroups.length) return null; const pageMap = new Map((pages || []).map((page) => [String(page.cid), page])); const used = new Set(); const groups = savedGroups.map((saved, index) => { const groupPages = (saved.pageCids || []).map((cid) => pageMap.get(String(cid))).filter(Boolean); groupPages.forEach((page) => used.add(String(page.cid))); return { key: String(saved.key || `group-restored-${index + 1}`), name: String(saved.name || `${String(index + 1).padStart(2, "0")}-小合集`), reason: String(saved.reason || ""), selected: saved.selected !== false, aggregateSelected: saved.aggregateSelected !== false, pages: groupPages }; }).filter((group) => group.pages.length || group.name); const rest = (pages || []).filter((page) => !used.has(String(page.cid))); if (rest.length) groups.push({ key: `group-unclassified-${Date.now().toString(36)}`, name: `${String(groups.length + 1).padStart(2, "0")}-未分类`, selected: true, aggregateSelected: true, pages: rest }); return groups.length ? groups : null; }
function checkpointKey(bvid) { return `boc_batch_checkpoint_${bvid}`; }
function extractBvid(value) { const text = String(value || "").trim(); return text.match(/BV[0-9A-Za-z]+/i)?.[0] || ""; }
function sanitize(value) { return String(value || "未命名").replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "未命名"; }
function clip(value, max) { const text = String(value || ""); return text.length > max ? `${text.slice(0, max)}\n\n（内容过长，已截断）` : text; }
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function checkObsidianConnection() { const node = $("obsidianStatus"); const baseUrl = String(state.settings?.obsidianApiBaseUrl || "").trim(); const apiKey = String(state.settings?.obsidianApiKey || "").trim(); if (!baseUrl || !apiKey) { if (node) node.textContent = "⚠ Obsidian 尚未配置：请点击右上角“设置”填写 Local REST API 地址和 Key。"; return false; } const resp = await runtime({ type: "test-obsidian-connection", baseUrl, apiKey }).catch((error) => ({ ok: false, error: error.message })); if (node) { node.textContent = resp?.ok ? "✓ Obsidian 已连接：生成的笔记会自动导入当前仓库。" : `⚠ Obsidian 连接失败：${resp?.error || "请确认 Obsidian 已打开"}`; node.style.color = resp?.ok ? "#15803d" : "#b45309"; } return Boolean(resp?.ok); }
async function checkAiConnection() { log("正在测试 AI 模型和接口地址..."); return Promise.race([runtime({ type: "batch-ai-preflight", providerId: state.providerId }), new Promise((resolve) => window.setTimeout(() => resolve({ ok: false, error: "AI 连接测试超过 30 秒，请检查接口状态后重试" }), 30000))]).catch((error) => ({ ok: false, error: error.message })); }
function runtime(message) { return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (resp) => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(resp); })); }
async function runBatchAiRequest(payload) { const requestId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; state.activeRequestId = requestId; try { return await runtime({ ...payload, type: "batch-ai-complete", requestId }); } finally { if (state.activeRequestId === requestId) state.activeRequestId = ""; } }
function cancelActiveBatchRequest() { const requestId = state.activeRequestId; if (requestId) runtime({ type: "batch-ai-cancel", requestId }).catch(() => {}); }
