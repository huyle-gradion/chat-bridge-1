# Agent loop sandbox

The agent loop runs setup, gates and every agent session in this image (`agent.sandbox` in `.factoryrc.json`).

Once per machine:

```bash
docker build -t chat-bridge-agent:1 docker/agent-sandbox
pnpm exec agentic-loop login     # sign agy in inside the container; paste the code back
```

Then run the loop as usual (`pnpm exec agentic-loop watch`). Before each run it checks the image has agy and the login volume `agentic-loop-agy-auth` holds a login.

When you change the Dockerfile, raise the tag (`chat-bridge-agent:2`) in both the build command and `.factoryrc.json`, so every teammate rebuilds. The agy installer always fetches the latest version, so rebuilding also upgrades agy; the run record names the version that ran.
