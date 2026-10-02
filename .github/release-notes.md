## Download EventKit {{VERSION}}

Install EventKit **at home, before the event**, sign in with the Google account you RSVP'd with, and click **Set up my laptop**.

| Your computer                             | Download                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows** 10 or 11                      | [EventKit-Setup-{{VERSION}}-x64.exe](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-Setup-{{VERSION}}-x64.exe)   |
| **Mac** with Apple silicon (M1 and later) | [EventKit-{{VERSION}}-arm64.dmg](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-arm64.dmg)           |
| **Mac** with Intel                        | [EventKit-{{VERSION}}-x64.dmg](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-x64.dmg)               |
| **Ubuntu**, Debian, Mint, Pop!_OS         | [EventKit-{{VERSION}}-x64.deb](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-x64.deb)               |
| **Fedora**, RHEL, openSUSE                | [EventKit-{{VERSION}}-x64.rpm](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-x64.rpm)               |
| **Arch**, Manjaro, EndeavourOS            | [EventKit-{{VERSION}}-x64.pkg.tar.xz](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-x64.pkg.tar.xz) |
| **Any other Linux**                       | [EventKit-{{VERSION}}-x64.AppImage](https://github.com/{{REPO}}/releases/download/v{{VERSION}}/EventKit-{{VERSION}}-x64.AppImage)     |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon.

### Installing

- **Windows:** run the installer. If you see "Windows protected your PC", click **More info → Run anyway**.
- **Mac:** open the .dmg and drag EventKit to Applications. The first time, right-click EventKit → **Open**. If macOS still refuses, go to System Settings → Privacy & Security and click **Open Anyway**.
- **Ubuntu / Debian:** `sudo apt install ./EventKit-{{VERSION}}-x64.deb`
- **Fedora:** `sudo dnf install ./EventKit-{{VERSION}}-x64.rpm`
- **Arch:** `sudo pacman -U EventKit-{{VERSION}}-x64.pkg.tar.xz`
- **AppImage:** `chmod +x EventKit-{{VERSION}}-x64.AppImage`, then run it. On Ubuntu 24.04 and later, use the .deb instead: Ubuntu blocks the AppImage's sandbox.

Linux builds run on both Wayland and X11. Windows and the AppImage update themselves; the other Linux packages update when you install a newer version.

### Checking your download

`SHA256SUMS.txt` lists the SHA-256 of every file: `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (Mac), `Get-FileHash .\EventKit-Setup-{{VERSION}}-x64.exe` (Windows).
