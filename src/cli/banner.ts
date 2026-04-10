const LOGO = `
  _
 | |_ ___  _ __ ___   ___
 | __/ _ \\| '_ \` _ \\ / _ \\
 | || (_) | | | | | | (_) |
  \\__\\___/|_| |_| |_|\\___/
`;

export function printBanner(subtitle?: string): void {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

  console.log(cyan(LOGO));
  if (subtitle) {
    console.log(`  ${dim(subtitle)}`);
    console.log();
  }
}
