---
name: identity
description: Connect 110lab services through the shared Feishu identity without sharing service permissions or exposing credentials.
---

Use `lab_sign_in` to open the shared 110lab authentication page when the user asks to sign in or switch services. The user personally signs in with their organization Feishu account. Do not authorize new scopes or approve on their behalf.

The portal tools, knowledge tools and requirements tools reuse that browser identity, but retain separate audience-specific service credentials and existing permissions. A portal administrator is not automatically a knowledge-space or requirements administrator.

For requirements call `lab_connect_requirements`. Its browser flow returns credentials directly to the same client; do not ask the user to paste a connection code. First use may require a native requirements-platform confirmation, preserving that application's access range. Check `lab_requirements_connection_status` after they finish. Do not claim success from a URL alone.

For knowledge use `kb_connect`; the browser uses the same shared login followed by the requested document scopes. Confirm with `kb_whoami`. The knowledge service is https://knowledge.110-lab.cn. Its client must have campus networking or the lab VPN. ChatGPT cloud cannot reach the private network; report that boundary rather than pretending a connection succeeded.

Candidate accounts and teaching-system student/teacher roles remain in their original systems. Never merge accounts by email, invent a connection, copy browser cookies or expose saved tokens. When authorization is expired, revoked or unavailable, report the actual state and reconnect through the supported flow.

已登录的同一浏览器自动续接已知服务；不同浏览器及新客户端仍各自首次绑定。已有插件令牌在原期限内自动续期，不延长授权、不复制 Cookie、不跳过新权限确认。
