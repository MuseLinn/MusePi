const fs = require('fs');
const content = fs.readFileSync('packages/coding-agent/src/modes/interactive/components/settings-selector.ts', 'utf8');
const lines = content.split('\n');
for (let i = 648; i <= 665; i++) {
    const line = lines[i-1];
    const tabCount = (line.match(/^\t/g) || []).length;
    console.log(`Line ${i} (${tabCount} tabs): ${JSON.stringify(line.slice(0, 100))}`);
}
