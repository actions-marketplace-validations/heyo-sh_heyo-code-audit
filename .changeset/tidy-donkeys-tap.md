---
"@heyo-sh/heyo-code-audit": minor
---

Raise the default Pi session budget so normal pull requests stop failing with
`Pi audit session exceeded the turn limit`. The previous 8,000-token response
budget was too small for a high thinking level: reasoning truncated each
response, the agent spent turns continuing itself, and discovery hit the
12-turn limit before reporting findings. Turns, tool calls, and the response
budget are now raised together, while the byte and result caps grow
conservatively to keep tool output inside the model context.
