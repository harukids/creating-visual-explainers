# Instagram Assistant Web (Slack first)

このフォルダは、画像からInstagram投稿案を生成し、必要に応じてSlackへ通知する最小構成です。

## 1. できること

- 画像1枚をアップロードして投稿案JSONを生成（初回）
- 画像要約を保存し、再生成時は画像を再送せずテキストだけで生成（コスト削減）
- 画面に結果を見やすく表示
- チェックON時にSlackへ要約通知を送信
- （オプション）**毎日定時**に `api/cron-daily` が動き、投稿案を生成して Slack へ送る

## 2. 事前準備

1. OpenAI APIキーを発行
2. SlackのIncoming Webhook URLを作成
3. Vercelアカウントを用意

## 3. 環境変数

`.env.example` を参考に以下を設定します。

- `OPENAI_API_KEY` (必須)
- `SLACK_WEBHOOK_URL` (Slack通知を使う場合は必須)
- `DEFAULT_WORK_CONTEXT` (任意: 画面から仕事文脈を空にしたときだけサーバー側の既定を足す。自分用デプロイ向け)
- `BRAND_GUIDELINES` (任意: 複数行可。**設定すると** `api/generate.js` 内の既定ブランド文を**まるごと置き換え**。チーム用テンプレに差し替えるときに使用)

### 仕事に落ちる文案にするために（入力の指針）

出力が薄くなりやすいのは、**「誰の・どんな悩みに・何のために」**がプロンプトに載っていないときです。次を具体的に書くと改善しやすいです。

| 画面の項目 | 書くとよいこと |
|------------|----------------|
| **発信の文脈** | 誰向けか（例：30代・個人事業・地域の親子） |
| **仕事・サービス・達成したいこと** | あなたの肩書き・提供していること・この投稿で読者にしてほしい行動（保存／相談／資料請求など） |
| **避けたい表現** | 業界コンプラ、言いたくない言い回し |
| **再生成ヒント** | もっと事例寄り／数字を入れたい／トーンを硬く など |

毎日Cronを使う場合は、同じ内容を **`CRON_AUDIENCE`** と **`CRON_WORK_CONTEXT`**（仕事・目的の長めの一文〜数行）に環境変数で入れておくと、自動生成もブレにくくなります。

## 4. ローカル起動

```bash
cd instagram-assistant-web
cp .env.example .env
# .env を編集してキーを設定
npx vercel@latest dev
```

起動後に表示されるURLを開きます。

## 5. Vercel公開

1. Vercelで「New Project」
2. リポジトリを選択
3. Root Directory を `instagram-assistant-web` に設定
4. Environment Variables に上記キーを登録
5. Deploy

## 6. 毎日自動（Cron）

`vercel.json` で **`0 23 * * *`（UTC）** に `/api/cron-daily` が呼ばれます。  
日本時間では **毎日おおよそ 朝 8:00（JST）** 相当です（サマータイムは無いので UTC+9 固定）。

### 必要な環境変数（Vercel）

| 名前 | 説明 |
|------|------|
| `CRON_SECRET` | 長めのランダム文字列。Cron 実行時の `Authorization: Bearer …` と一致させる（Vercel の Cron 設定でも同じ値を参照） |
| `SLACK_WEBHOOK_URL` | 通知先（未設定ならスキップメッセージも送れない） |
| **どちらか一方** | 下記 `DAILY_IMAGE_URL` **または** `DAILY_IMAGE_SUMMARY` |

**ソース（どちらか1つ）**

- **`DAILY_IMAGE_URL`** … 公開されている画像の HTTPS URL（その日の写真）。`/api/generate` の **analyze** で処理（画像トークンがかかる）。
- **`DAILY_IMAGE_SUMMARY`** … テキストだけの要約（アプリで一度生成した要約をここにコピーしてもよい）。**regenerate** のみ（画像は送らず安い）。

任意:

- `CRON_AUDIENCE` / `CRON_WORK_CONTEXT` / `CRON_NG_WORDS` / `CRON_VARIATION_HINT` … 生成プロンプトに渡す文字列（`CRON_WORK_CONTEXT` は画面の「仕事・達成したいこと」に相当）

### 動作のしかた

1. 上記を Vercel の Environment Variables に保存し、**Redeploy**
2. デプロイ後、Vercel ダッシュボードの **Cron Jobs** で `/api/cron-daily` が有効か確認
3. 設定が足りないときは Slack に短い警告が届くことあり

### 手動テスト（任意）

```bash
curl -sS -H "Authorization: Bearer YOUR_CRON_SECRET" "https://あなたのドメイン.vercel.app/api/cron-daily"
```

### 将来の拡張

画像を毎日自動で差し替えるなら、**Supabase Storage** などにアップロードし、その **公開 URL を `DAILY_IMAGE_URL` に書き換える**運用か、別APIで URL を取得する形にできます。

## 7. LINE追加は後でOK

Slackで運用が安定した後、通知処理を分岐してLINE Messaging APIを追加できます。
まずはSlackのみで品質と運用フローを固めるのがおすすめです。
