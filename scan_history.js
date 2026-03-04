const fs = require('fs');
const path = require('path');

const historyDir = path.join(process.env.APPDATA, 'Code', 'User', 'History');

if (!fs.existsSync(historyDir)) {
    console.log('No VS Code history found.');
    process.exit(0);
}

const folders = fs.readdirSync(historyDir);
const results = [];

for (const folder of folders) {
    const entriesPath = path.join(historyDir, folder, 'entries.json');
    if (fs.existsSync(entriesPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
            const filePath = data.resource || data.id;

            if (filePath && filePath.includes('ram-jam') && filePath.includes('public')) {
                const latestEntry = data.entries[data.entries.length - 1];
                const backupFile = path.join(historyDir, folder, latestEntry.id);
                results.push({
                    original: filePath,
                    backup: backupFile,
                    time: latestEntry.timestamp
                });
            }
        } catch (e) { }
    }
}

results.sort((a, b) => b.time - a.time);
console.log(JSON.stringify(results.slice(0, 10), null, 2));
