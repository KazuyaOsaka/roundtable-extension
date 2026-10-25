#!/usr/bin/env node
// Entry point: `npm start` (see README for setup).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.RT_DATA_DIR || path.join(here, "../data");
const chairPort = Number(process.env.RT_CHAIR_PORT || 8787);
const participantPort = Number(process.env.RT_PARTICIPANT_PORT || 8788);

const app = await startApp({ dataDir, chairPort, participantPort });
console.log(`Roundtable 起動しました。
  議長画面（このPCのブラウザで開く）: http://127.0.0.1:${app.chairPort}/
  参加者用ポート（トンネルで公開する）: http://127.0.0.1:${app.participantPort}/
  公開URL: ${app.config.publicUrl || "（未設定。議長画面の「接続設定」で入力してください）"}
  データ保存先: ${dataDir}
終了するには Ctrl+C`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
