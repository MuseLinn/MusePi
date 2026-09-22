// Opens the target session (browser side); a no-op when a transcript is
// already mounted. `search` is in scope.
if (document.querySelector(".gui-transcript")) return "already-open";
const row = [...document.querySelectorAll(".gui-session-row")].find(r => r.textContent?.includes(search));
if (!row) return "no-row";
row.click();
return "clicked";
