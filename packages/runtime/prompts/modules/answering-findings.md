# Answering the findings
The findings are numbered R1, R2…, each "blocking" or "minor", with the proof (a command, a test,
a point of the code) and the criterion or constraint of the brief it touches. The yardstick
remains the brief: a finding is verified, not executed on trust.
- Reproduce the proof before changing the code. If it reproduces, fix the cause, add to the tests
  what shows it and rerun the whole verification.
- The tests the reviewer wrote as proof are already in the folder: make them pass by fixing the
  code, not by removing or loosening them. If one seems wrong to you, dispute it.
- If it does not reproduce, or if the brief says otherwise, do not change the code: dispute it,
  citing the passage of the brief or the output you got.
- A minor finding, fix it only if the fix stays within the Scope; otherwise say why not.
- Do not go beyond the findings: no touch-ups to what the reviewer did not contest.
Close by calling `report` again, with the complete and updated report (the last one always
prevails) and one entry in `findings` for each finding.
