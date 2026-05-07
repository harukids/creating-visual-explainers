# Instagram Assistant Web (Slack first)

このフォルダは、画像からInstagram投稿案を生成し、必要に応じてSlackへ通知する最小構成です。

## 1. できること

- 画像1枚をアップロードして投稿案JSONを生成（初回）
- 画像要約を保存し、再生成時は画像を再送せずテキストだけで生成（コスト削減）
- 画面に結果を見やすく表示
- チェックON時にSlackへ要約通知を送信

## 2. 事前準備

1. OpenAI APIキーを発行
2. SlackのIncoming Webhook URLを作成
3. Vercelアカウントを用意

## 3. 環境変数

`.env.example` を参考に以下を設定します。

- `OPENAI_API_KEY` (必須)
- `SLACK_WEBHOOK_URL` (Slack通知を使う場合は必須)
- `ACCESS_CODE` (任意: APIを簡易保護)
- `DUMMY_MODE` (任意: `true` でOpenAIを呼ばずダミーJSONを返す。課金前の画面確認用)

### セキュリティのメモ

- **ダミーモード**は **`DUMMY_MODE` 環境変数が設定されているときだけ**有効です。リクエストbodyでダミーに切り替えることはできません。
- URLを公開する場合は、悪用やSlack通知の乱用を防ぐため **`ACCESS_CODE` の設定を推奨**します。

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

## 6. 毎日運用への拡張（次のステップ）

1. 当日画像を保存する場所（Supabase Storage など）を決める
2. Cron用API (`api/cron-daily.js`) を追加
3. Vercel Cronで毎朝実行
4. `api/generate` を呼び、結果をSlackへ通知

## 7. LINE追加は後でOK

Slackで運用が安定した後、通知処理を分岐してLINE Messaging APIを追加できます。
まずはSlackのみで品質と運用フローを固めるのがおすすめです。
