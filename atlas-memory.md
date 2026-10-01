# Atlas Builder Memory
This file serves as persistent memory for the Atlas AI builder loop across 
all tickets. After every ticket completion, append exactly one `Learned:` l
line documenting a codebase quirk, implementation failure, or operational l
lesson observed during work. The entire history of these insights forms the
the contextual memory base for future development tasks within this reposit
repository.

## Rules
1. After every ticket, append one `Learned:` line (one per ticket) at the e
end of this file.
2. Every new ticket begins by reading and parsing all prior `Learned:` line
lines in this file.
