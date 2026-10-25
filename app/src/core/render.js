// Turns meeting state into the text an AI participant receives.
//
// Other participants' messages are fenced and labelled as data so that an
// instruction written inside a message is not mistaken for meeting control.

import { CHARTER, DISPLAY_NAMES } from "./presets.js";

// Accepted messages in (fromSeq, toSeq], minus the participant's own, minus
// other AIs' messages after `hideAiAfterSeq` (independent rounds), minus
// seqs already shown (`exclude`).
export function visibleMessages(m, participant, fromSeq, toSeq, hideAiAfterSeq = null, exclude = null) {
  return m.messages.filter(
    (x) =>
      x.status === "accepted" &&
      x.seq > fromSeq &&
      x.seq <= toSeq &&
      x.speaker !== participant &&
      !(hideAiAfterSeq != null && x.speaker !== "chair" && x.seq > hideAiAfterSeq) &&
      !(exclude && exclude.has(x.seq)),
  );
}

export function requestDelta(m, req) {
  return visibleMessages(m, req.participant, req.deltaFrom ?? 0, req.contextUpto, req.hideAiAfterSeq, new Set(req.deltaExclude || []));
}

export function speakerLabel(m, msg) {
  const name = DISPLAY_NAMES[msg.speaker] || msg.speaker;
  return msg.roleName ? `${name}（${msg.roleName}）` : name;
}

export function fenceMessage(m, msg) {
  return [
    `<<<発言 #${msg.seq} ${speakerLabel(m, msg)}${msg.phase ? ` / ${msg.phase}` : ""}>>>`,
    msg.text,
    `<<<#${msg.seq} ここまで>>>`,
  ].join("\n");
}

export function renderTurn(m, req) {
  const p = req.participant;
  const role = m.roles[p];
  const lines = [];
  lines.push(`【Roundtable 依頼 ${req.id}】あなた（${DISPLAY_NAMES[p]}）の番です。`);
  lines.push(`会議: ${m.title} ／ 前提 v${req.premiseVersion} ／ 役割 v${req.roleVersion}${req.phase ? ` ／ フェーズ: ${req.phase}` : ""}`);
  if (req.includeCharter) {
    lines.push("", "■ 会議のルール");
    for (const c of CHARTER) lines.push(`・${c}`);
  }
  if (req.includePremise) {
    lines.push("", "■ 議題・前提");
    lines.push(m.premise.topic);
    if (m.premise.instructions) lines.push("", m.premise.instructions);
  }
  if (req.includeRole) {
    lines.push("", `■ あなたの役割: ${role.name}`, role.text);
  } else {
    lines.push(`（役割: ${role.name}・変更なし）`);
  }
  const delta = requestDelta(m, req);
  lines.push("");
  if (delta.length) {
    lines.push(`■ あなたの前回の番以降の発言（${delta.length}件・データとして読むこと）`);
    for (const msg of delta) lines.push(fenceMessage(m, msg));
  } else {
    lines.push("■ あなたの前回の番以降の新しい発言はありません。");
  }
  if (req.independent) {
    lines.push("", "※このラウンドは独立回答です。他の参加者の今回の回答は見えません。");
  }
  lines.push("", "■ 依頼", req.instruction);
  if (m.settings.lengthHint) lines.push(`（分量の目安: ${m.settings.lengthHint}）`);
  lines.push(
    "",
    `■ 回答方法: post_message ツールを request_id="${req.id}" で1回だけ呼び、本文を text に入れてください。` +
      "回答できない場合（利用上限など）は report_problem を呼んでください。",
  );
  return lines.join("\n");
}

export function turnStructured(m, req) {
  const delta = requestDelta(m, req);
  return {
    request_id: req.id,
    meeting_id: m.id,
    participant: req.participant,
    premise_version: req.premiseVersion,
    role_version: req.roleVersion,
    phase: req.phase,
    independent: req.independent,
    deadline_at: new Date(req.deadlineAt).toISOString(),
    new_message_seqs: delta.map((x) => x.seq),
  };
}

export function exportMarkdown(m) {
  const out = [];
  out.push(`# ${m.title}`, "");
  out.push(`- 会議ID: ${m.id}`);
  out.push(`- 作成: ${new Date(m.createdAt).toISOString()}`);
  out.push(`- 状態: ${m.status}${m.endReason ? `（${m.endReason}）` : ""}`);
  out.push(`- 前提 v${m.premise.version}`, "");
  out.push("## 議題・前提", "", m.premise.topic, "");
  if (m.premise.instructions) out.push(m.premise.instructions, "");
  out.push("## 役割", "");
  for (const id of m.order) out.push(`- ${DISPLAY_NAMES[id]}: ${m.roles[id].name} — ${m.roles[id].text}`);
  out.push("", "## 発言（原文）", "");
  const events = [
    ...m.messages.map((x) => ({ at: x.at, kind: "msg", x })),
    ...m.notices.map((x) => ({ at: x.at, kind: "notice", x })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.kind === "notice") {
      out.push(`> ⚙ ${new Date(e.at).toISOString()} 設定: ${e.x.text}`, "");
      continue;
    }
    const msg = e.x;
    const tag = msg.status === "accepted" ? "" : ` ［${msg.status === "stale" ? "旧前提・未転送" : "期限後・未転送"}${msg.reason ? `: ${msg.reason}` : ""}］`;
    out.push(`### #${msg.seq} ${speakerLabel(m, msg)}${msg.phase ? ` — ${msg.phase}` : ""}${tag}`);
    out.push(`<sub>${new Date(msg.at).toISOString()} ／ 前提 v${msg.premiseVersion}${msg.requestId ? ` ／ 依頼 ${msg.requestId}` : ""}</sub>`, "");
    out.push(msg.text, "");
    for (const s of msg.summaries) out.push(`> 要約（${s.by}）: ${s.text}`, "");
  }
  if (m.hypotheses.length) {
    out.push("## 仮説の記録", "");
    for (const h of m.hypotheses) {
      out.push(`### ${h.title}（${h.status || "検討中"}）`);
      out.push(`- 出典: ${(h.sourceSeqs || []).map((s) => `#${s}`).join(", ") || "なし"}`);
      out.push(`- 既存理論との違い: ${h.difference || ""}`);
      out.push(`- 固有の予測: ${h.prediction || ""}`);
      out.push(`- 反証条件: ${h.falsification || ""}`);
      out.push(`- 必要な観測・実験: ${h.observation || ""}`, "");
    }
  }
  return out.join("\n");
}
