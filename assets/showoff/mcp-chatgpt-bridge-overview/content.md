# mcp-chatgpt-bridge — Showcase Content

Mission slug: `mcp-chatgpt-bridge-overview`
Languages: vi, en (dual/parallel treatment)
Sections: hero, problem, architecture, features, security, quickstart (6 total)

---

## Section: hero

### vi
**mcp-chatgpt-bridge**
Cho Claude Code một "ý kiến thứ hai" — ngay giữa tác vụ, không rời terminal.

Server MCP nhẹ, kết nối Claude Code với AI advisor (OpenAI hoặc Gemini) để tham vấn tức thời — có ngữ cảnh rõ ràng, có log, có audit.

### en
**mcp-chatgpt-bridge**
Give Claude Code a second opinion — mid-task, without leaving the terminal.

A lightweight MCP server that bridges Claude Code to an AI advisor (OpenAI or Gemini) for instant consultation — explicit context, logged, auditable.

---

## Section: problem

### vi
**Vấn đề:** Khi Claude Code gặp điểm quyết định quan trọng (pattern A hay B? cách xử lý lỗi này đúng không?), hỏi thêm 1 AI khác nhanh hơn hỏi người — nhưng chỉ khi:
1. AI tư vấn thấy đúng ngữ cảnh cần thiết (không phải toàn bộ repo/lịch sử chat).
2. Con người vẫn có bản ghi đầy đủ đã hỏi gì, được khuyên gì.
3. Công cụ không làm gián đoạn luồng làm việc chính.

**Giải pháp:** Một tool MCP duy nhất — `ask_chatgpt(question, context, model?)` — với side-channel đẩy kết quả về Telegram/Slack để review offline.

### en
**Problem:** When Claude Code hits a real decision point (pattern A or B? is this error handling correct?), asking another AI is faster than asking a human — but only if:
1. The advisor sees exactly the right context (not the whole repo or chat history).
2. The human keeps a full record of what was asked and recommended.
3. The tool never interrupts the primary workflow.

**Solution:** One focused MCP tool — `ask_chatgpt(question, context, model?)` — with a side-channel push to Telegram/Slack for async human review.

---

## Section: architecture

### vi
**Kiến trúc:** Claude Code gọi tool `ask_chatgpt` qua stdio. Server tra active provider trong SQLite, chọn key theo LRU (ưu tiên key lâu chưa dùng, bỏ qua key đang cooldown), gọi provider tương ứng (OpenAI/Gemini), ghi log kết quả (usage_events + file log hàng ngày), rồi đẩy thông báo song song tới Telegram/Slack trước khi trả kết quả về Claude Code.

Toàn bộ cấu hình (API keys, provider đang dùng, secrets Telegram/Slack) sống trong SQLite cục bộ — quản lý qua dashboard web, không cần file `.env`.

Được xây trên chuẩn mở **Model Context Protocol (MCP)** của Anthropic — cho phép AI client kết nối chuẩn hoá tới các data/tool server, không cần tích hợp riêng lẻ.[^1]

### en
**Architecture:** Claude Code calls the `ask_chatgpt` tool over stdio. The server looks up the active provider in SQLite, picks a key via LRU rotation (favoring least-recently-used, skipping keys in cooldown), dispatches to the matching provider (OpenAI/Gemini), logs the outcome (usage_events table + daily file log), then pushes notifications to Telegram/Slack in parallel before returning the result to Claude Code.

All configuration (API keys, active provider, Telegram/Slack secrets) lives in local SQLite — managed via a web dashboard, no `.env` file required.

Built on Anthropic's open **Model Context Protocol (MCP)** standard — letting AI clients connect to data/tool servers through one standardized interface instead of custom integrations per tool.[^1]

---

## Section: features

### vi
**Tính năng chính:**
- **Dual-provider:** OpenAI và Gemini, chọn qua dashboard, auto-route sang OpenRouter theo prefix key.
- **Key rotation LRU + cooldown:** rải tải nhiều key, tự tránh key đang bị rate-limit (429 → cooldown 60s).
- **Truncation guard:** giới hạn input 60K ký tự / output 20K ký tự — chặn chi phí token bất ngờ.
- **Audit log đầy đủ:** file log hàng ngày (`logs/YYYY-MM-DD.log`) ghi toàn bộ câu hỏi/ngữ cảnh/câu trả lời + mọi HTTP request, xem trực tiếp qua dashboard.
- **Thông báo best-effort:** đẩy song song Telegram + Slack, lỗi gửi không chặn kết quả trả về.

### en
**Key features:**
- **Dual-provider:** OpenAI and Gemini, switchable via dashboard, auto-routes to OpenRouter by key prefix.
- **LRU key rotation + cooldown:** spreads load across keys, automatically avoids rate-limited keys (429 → 60s cooldown).
- **Truncation guards:** 60K-char input / 20K-char output caps — prevents surprise token cost spikes.
- **Full audit log:** daily log file (`logs/YYYY-MM-DD.log`) captures every question/context/answer plus every HTTP request, viewable directly in the dashboard.
- **Best-effort notifications:** parallel push to Telegram + Slack; delivery failures never block the tool result.

---

## Section: security

### vi
**Bảo mật theo thiết kế:**
- Dashboard chỉ bind `127.0.0.1` — không hỗ trợ remote/multi-user, phù hợp use-case cá nhân local.
- API keys lưu trong SQLite (`data.sqlite`, quyền `0o600`) — không bao giờ log ra dạng plain text.
- Route `fetch-models` (gọi endpoint ngoài kèm API key thật) có 2 lớp phòng thủ riêng: `requireSameOriginStrict` (từ chối request không có `Origin`) và `validateFetchModelsTarget` (chặn loopback/link-local/`169.254.169.254`/private range/CGNAT, pin IP đã resolve để tránh DNS-rebinding TOCTOU).
- Thiết kế này ra đời sau một vòng **red-team review đối kháng trước khi code** — bản thiết kế đầu (chỉ dựa vào `validateBaseURL` + same-origin lỏng) không thực sự chặn được SSRF/rò rỉ credential.

### en
**Security by design:**
- Dashboard binds `127.0.0.1` only — no remote/multi-user support, matches its local single-user use case.
- API keys stored in SQLite (`data.sqlite`, mode `0o600`) — never logged in plain text.
- The `fetch-models` route (calls an external endpoint carrying a real API key) has two extra defenses beyond the rest of the app: `requireSameOriginStrict` (rejects requests with no `Origin` header) and `validateFetchModelsTarget` (blocks loopback/link-local/`169.254.169.254`/private ranges/CGNAT, pinning the resolved IP to close a DNS-rebinding TOCTOU gap).
- This design emerged from an **adversarial red-team review pass before implementation** — the original design (relying only on `validateBaseURL` + a lenient same-origin check) did not actually close the SSRF/credential-exfiltration risk.

---

## Section: quickstart

### vi
```bash
npm install && npm run build
npm run web                         # Dashboard tại http://localhost:4141
npm run install-hooks               # cài hook ask-chatgpt-gate vào ~/.claude
claude mcp add chatgpt-bridge -s user -- node "$(pwd)/dist/index.js"
```
Không cần biến môi trường — mọi cấu hình qua dashboard.

### en
```bash
npm install && npm run build
npm run web                         # Dashboard at http://localhost:4141
npm run install-hooks               # installs the ask-chatgpt-gate hooks into ~/.claude
claude mcp add chatgpt-bridge -s user -- node "$(pwd)/dist/index.js"
```
No environment variables needed — all configuration lives in the dashboard.

---

## References

[^1]: [Introducing the Model Context Protocol — Anthropic](https://www.anthropic.com/news/model-context-protocol) · [Model Context Protocol specification — GitHub](https://github.com/modelcontextprotocol/modelcontextprotocol) · [What is Model Context Protocol (MCP)? — Google Cloud](https://cloud.google.com/discover/what-is-model-context-protocol)
