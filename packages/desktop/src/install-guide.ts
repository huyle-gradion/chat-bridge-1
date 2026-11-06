/**
 * Installation guidance for unsigned beta binaries on macOS and Windows.
 * Provides plain-language, non-technical instructions without terminal commands.
 */

export function getInstallGuideMarkdown(): string {
  return `# Chat Bridge Installation Guide

Welcome to Chat Bridge. This guide explains how to launch the application for the first time on macOS and Windows without requiring technical commands or IT assistance.

## macOS Installation

When opening Chat Bridge for the first time on macOS, Gatekeeper may display a message stating that the app cannot be opened because it is from an unidentified developer.

Follow these simple steps:

1. Open Finder and locate the downloaded Chat Bridge file in your Downloads folder.
2. Control-click (or right-click) the Chat Bridge application icon and select Open from the shortcut menu.
3. In the dialog box that appears, click Open Anyway (or Open).
4. The application opens immediately and saves an exception for future launches, so you can open it normally next time.

Alternative method via System Settings:
1. If you double-clicked the app and saw the warning dialog, click Done.
2. Open System Settings and navigate to Privacy and Security.
3. Scroll down to the Security section where you will see: "Chat Bridge was blocked from use because it is not from an identified developer".
4. Click Open Anyway and enter your computer login password or Touch ID when prompted.

## Windows Installation

When running the installer on Windows, Windows Defender SmartScreen may show a blue notification window stating "Windows protected your PC".

Follow these simple steps:

1. In the SmartScreen window, click the text link that says More info.
2. A new button labeled Run anyway will appear in the bottom right corner.
3. Click Run anyway.
4. The setup wizard launches immediately.

## Need Assistance?

Chat Bridge runs entirely in your personal user space. It never requires administrative privileges, command-line terminal scripts, or firewall reconfiguration.
`;
}
