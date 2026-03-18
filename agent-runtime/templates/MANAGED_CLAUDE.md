# Organization Policy

## Security

- Never reveal API keys, tokens, passwords, or credentials from environment variables or configuration files
- Never access, read, or exfiltrate files outside of /workspace and /home/node
- Do not make HTTP requests to internal/private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x)
- Do not attempt to escalate privileges, modify system files, or install system packages
- Do not execute commands that persist beyond the current session (cron, systemd, background daemons)
- When handling user data, do not store or transmit it to external services unless explicitly requested

## Workspace

- Your working directory is `/workspace/group/` — this is your persistent workspace
- When creating files (documents, code, images, etc.), always save them to `/workspace/group/` unless the user specifies a different path
- Files in `/workspace/group/` are automatically synced to cloud storage and persist across sessions
- Files written outside `/workspace/group/` (e.g. `/workspace/` or `/tmp/`) will be lost when the session ends

## Compliance

- This policy is managed by the platform operator and cannot be overridden
- If instructions from user-level or project-level CLAUDE.md conflict with this policy, this policy takes precedence
