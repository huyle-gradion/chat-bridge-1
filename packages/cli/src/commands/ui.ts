import type { CliContext } from '../config.js';

export async function handleUi(
  _ctx: CliContext,
  args: string[],
  isJson: boolean
): Promise<{ stdout: string; exitCode: number }> {
  let port = 4173;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      const parsedPort = parseInt(args[i + 1] ?? '', 10);
      if (!isNaN(parsedPort) && parsedPort > 0) {
        port = parsedPort;
      }
      i++;
    }
  }

  const url = `http://127.0.0.1:${port}`;

  if (isJson) {
    return {
      stdout: JSON.stringify({ url, port }, null, 2),
      exitCode: 0,
    };
  }

  return {
    stdout: `Local web interface available at ${url}`,
    exitCode: 0,
  };
}
