# Atlas Builder Memory

This file is the persistent memory for the Atlas AI builder loop. After every ticket, Atlas appends exactly one `Learned:` line documenting a codebase quirk, an implementation failure, or an operational lesson observed during the work. The accumulated history forms the contextual memory base for future tickets in this repository.

## Rules

1. After every ticket, append one `Learned:` line (one per ticket) at the end of this file.
2. Every new ticket begins by reading and parsing all prior `Learned:` lines in this file.
