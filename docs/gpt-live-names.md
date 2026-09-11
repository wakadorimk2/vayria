# GPT-Live integration terminology

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 候補語 | 初出定義 |
|---|---|---|---|---|---|---|
| Approved plan: connection | Separate persistent accounting from audio | One admitted OpenAI voice connection and its charge, owner, deadline and finalization | Accounting record | Created before upstream request; finalized from server events | LiveSessionRecord | Persistent accounting for one Live connection; contains no audio or transcript. |
| Approved plan: cards | Send complete current state | Revision, active card IDs and highlighted card ID | Context snapshot | Validated against cardPool before injection | LiveCardContext | Complete card placement for one revision. |
| Approved plan: sideband | Control a connection on the server | Upstream creation, sideband messages and closure | Transport controller | Uses ledger admission and provider events | LiveSessionManager | Server controller for admitted Live connections. |
| Approved plan: browser | Own browser audio resources | Peer connection, microphone, playback and captions | Browser controller | Starts after admission and releases resources on stop | LiveConversation | Browser lifetime of one Live conversation. |

Checked: each row identifies one responsibility; accounting is separate from transport and card context. No name represents both a Vayria public session and an OpenAI connection.

UI task: choose the staging voice engine, confirm the selection, then start the microphone. Settings is the discovery anchor; the selected radio confirms the engine; the existing microphone control starts/stops it. Connection failures and required playback gestures may interrupt this flow. The avatar remains the main visual focus outside settings. This is a design heuristic, not measured eye tracking.
