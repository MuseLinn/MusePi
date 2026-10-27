const [flag, file, extension] = process.argv.slice(2);
if (flag !== "--x" || !file || !extension) throw new Error("expected --x <file> <extension>");
if (!(await Bun.file(file).exists()) || (await Bun.file(file).size) === 0) process.exit(3);
console.log(`uploaded ${file}`);
console.log(`https://files.example/abc.${extension}`);
