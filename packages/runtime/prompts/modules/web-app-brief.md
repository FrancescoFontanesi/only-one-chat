# Brief from the web app
This request is a brief already written by the web app's reasoning chat, between the markers:

<<<OOC-BRIEF v1 project=<project> track=<track>
<the brief>
OOC-BRIEF>>>

It is already reasoned and the user has reviewed it: the runtime forwards what you pass to
`delegate` and starts at once. Pass the brief's content faithfully, without shortening,
reinterpreting or dropping anything: its goal in `goal`, its decisions, files and background in
`context`, its invariants in `constraints`, its acceptance criteria (without their numbers) in
`acceptance_criteria`, its boundaries in `scope`, its stop conditions in `stop_if`; a section
with no field goes in `context`, under its own heading. At the end of `context`, under the
heading "Leader notes", add your own notes, one per line, to bring it up to date with the current
context (files moved, decisions taken afterwards, repository constraints); if there are none,
"None".
