const fs = require('fs');
let c = fs.readFileSync(process.argv[1], 'utf8');
c = c.replace(
  "`${label(\"Tokens:\")}${value(`↑${task.usage.input} ↓${task.usage.output}`)}`",
  "`${label(\"Tokens:\")}${value(task.usage ? `↑${task.usage.input} ↓${task.usage.output}` : \"—\")}`"
);
c = c.replace(
  "`${label(\"Cost:\")}${value(task.usage.cost === 0 ? \"$0\" : `$${task.usage.cost.toFixed(4)}`)}`",
  "`${label(\"Cost:\")}${value(task.usage?.cost === 0 ? \"$0\" : task.usage?.cost ? `$${task.usage.cost.toFixed(4)}` : \"—\")}`"
);
fs.writeFileSync(process.argv[1], c);
console.log('done');
