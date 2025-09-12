const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const http = require('http');

class BuildBridge {
    constructor() {
        this.wsServer = new WebSocket.Server({ port: 8080 });
        this.setupWebSocketServer();
        console.log('Build bridge listening on ws://localhost:8080');

        this.fileServer = http.createServer((req, res) => {
            if (req.url.startsWith('/download/')) {
                const fileName = req.url.substring('/download/'.length);
                const filePath = path.join(__dirname, 'builds', fileName);

                if (fs.existsSync(filePath)) {
                    res.writeHead(200, {
                        'Content-Type': 'application/zip',
                        'Content-Disposition': `attachment; filename="${fileName}"`,
                    });
                    fs.createReadStream(filePath).pipe(res);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });
        
        this.fileServer.listen(8081, () => {
            console.log('File server running on http://localhost:8081');
        });
    }

    setupWebSocketServer() {
        this.wsServer.on('connection', (ws) => {
            console.log('WebSim client connected');

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (error) {
                    console.error('Invalid message:', error);
                }
            });

            ws.on('close', () => {
                console.log('WebSim client disconnected');
            });
        });
    }

    async handleMessage(ws, data) {
        if (data.type === 'build') {
            await this.handleBuild(ws, data);
        }
    }

    async handleBuild(ws, { url, platform, projectName, requestId }) {
        const outputDir = path.join(__dirname, 'builds', requestId);
        const zipFileName = `${projectName}-${platform}.zip`;
        const zipPath = path.join(__dirname, 'builds', zipFileName);

        try {
            if (!fs.existsSync(path.join(__dirname, 'builds'))) {
                fs.mkdirSync(path.join(__dirname, 'builds'));
            }

            this.sendProgress(ws, requestId, 'Preparing build environment...', 30);

            const arch = 'x64';
            const command = `npx nativefier "${url}" --name "${projectName}" --platform "${platform}" --arch "${arch}" --out "${outputDir}" --overwrite`;

            console.log('Running command:', command);
            
            this.sendProgress(ws, requestId, 'Building application...', 60);

            exec(command, { timeout: 300000 }, async (error, stdout, stderr) => {
                if (error) {
                    console.error('Build error:', stderr || stdout || error);
                    this.sendError(ws, requestId, `Build failed: ${error.message}`);
                    return;
                }

                try {
                    this.sendProgress(ws, requestId, 'Compressing application...', 80);
                    
                    const appDirName = fs.readdirSync(outputDir).find(file => fs.statSync(path.join(outputDir, file)).isDirectory());
                    if (!appDirName) {
                        throw new Error('Could not find built application directory.');
                    }
                    const builtAppDir = path.join(outputDir, appDirName);

                    await this.createZip(builtAppDir, zipPath);
                    
                    const downloadUrl = `http://localhost:8081/download/${zipFileName}`;
                    this.sendComplete(ws, requestId, downloadUrl);
                    this.sendProgress(ws, requestId, 'Build complete!', 100);

                    this.scheduleCleanup(outputDir, zipPath);

                } catch (zipError) {
                    console.error('Compression/Packaging error:', zipError);
                    this.sendError(ws, requestId, `Packaging failed: ${zipError.message}`);
                }
            });

        } catch (setupError) {
            console.error('Build setup error:', setupError);
            this.sendError(ws, requestId, `Build setup failed: ${setupError.message}`);
        }
    }

    createZip(sourceDir, outputPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => {
                console.log(`ZIP created: ${archive.pointer()} total bytes`);
                resolve();
            });
            output.on('error', (err) => reject(err));
            archive.on('error', (err) => reject(err));

            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }

    scheduleCleanup(outputDir, zipPath) {
        setTimeout(() => {
            try {
                if (fs.existsSync(outputDir)) {
                    fs.rmSync(outputDir, { recursive: true, force: true });
                    console.log(`Cleaned up build directory: ${outputDir}`);
                }
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                    console.log(`Cleaned up zip file: ${zipPath}`);
                }
            } catch (error) {
                console.error('Cleanup error:', error);
            }
        }, 3600000); // 1 hour
    }

    sendProgress(ws, requestId, message, progress) {
        ws.send(JSON.stringify({ type: 'build_progress', requestId, message, progress }));
    }

    sendComplete(ws, requestId, downloadUrl) {
        ws.send(JSON.stringify({ type: 'build_complete', requestId, downloadUrl }));
    }

    sendError(ws, requestId, error) {
        ws.send(JSON.stringify({ type: 'build_error', requestId, error }));
    }
}

new BuildBridge();

