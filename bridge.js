const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

class BuildBridge {
    constructor() {
        this.server = new WebSocket.Server({ port: 8080 });
        this.setupServer();
        console.log('Build bridge listening on ws://localhost:8080');
    }

    setupServer() {
        this.server.on('connection', (ws) => {
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
        switch (data.type) {
            case 'build':
                await this.handleBuild(ws, data);
                break;
        }
    }

    async handleBuild(ws, { url, platform, projectName, requestId }) {
        const outputDir = path.join(__dirname, 'builds', requestId);
        const zipPath = path.join(__dirname, 'builds', `${projectName}-${platform}.zip`);

        try {
            // Create builds directory
            if (!fs.existsSync(path.join(__dirname, 'builds'))) {
                fs.mkdirSync(path.join(__dirname, 'builds'));
            }

            // Send progress update
            this.sendProgress(ws, requestId, 'Preparing build environment...', 30);

            // Build command
            const arch = platform === 'darwin' ? 'x64' : 'x64'; // Can be made configurable
            const command = `npx nativefier "${url}" --name "${projectName}" --platform "${platform}" --arch "${arch}" --out "${outputDir}" --overwrite`;

            console.log('Running command:', command);
            
            this.sendProgress(ws, requestId, 'Building application...', 60);

            exec(command, { timeout: 300000 }, async (error, stdout, stderr) => {
                if (error) {
                    console.error('Build error:', error);
                    this.sendError(ws, requestId, `Build failed: ${error.message}`);
                    return;
                }

                try {
                    this.sendProgress(ws, requestId, 'Compressing application...', 80);

                    // Find the built app directory
                    const builtAppDir = this.findBuiltApp(outputDir, projectName);
                    if (!builtAppDir) {
                        throw new Error('Built application not found');
                    }

                    // Create ZIP
                    await this.createZip(builtAppDir, zipPath);

                    this.sendProgress(ws, requestId, 'Upload complete!', 100);

                    // Upload to a file sharing service or serve locally
                    const downloadUrl = await this.uploadFile(zipPath);

                    this.sendComplete(ws, requestId, downloadUrl);

                    // Cleanup
                    this.cleanup(outputDir, zipPath);

                } catch (zipError) {
                    console.error('Compression error:', zipError);
                    this.sendError(ws, requestId, `Compression failed: ${zipError.message}`);
                }
            });

        } catch (error) {
            console.error('Build setup error:', error);
            this.sendError(ws, requestId, `Build setup failed: ${error.message}`);
        }
    }

    findBuiltApp(outputDir, projectName) {
        try {
            const files = fs.readdirSync(outputDir);
            for (const file of files) {
                const filePath = path.join(outputDir, file);
                if (fs.statSync(filePath).isDirectory()) {
                    return filePath;
                }
            }
        } catch (error) {
            console.error('Error finding built app:', error);
        }
        return null;
    }

    createZip(sourceDir, outputPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => {
                console.log(`ZIP created: ${archive.pointer()} total bytes`);
                resolve();
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }

    async uploadFile(filePath) {
        // For development, serve files locally
        // In production, upload to S3, file.io, or similar service
        
        try {
            // Read file and upload to WebSim's file storage
            const fileBuffer = fs.readFileSync(filePath);
            const file = new File([fileBuffer], path.basename(filePath), { type: 'application/zip' });
            
            // Use WebSim's upload functionality (this would need to be integrated)
            // For now, return a placeholder URL
            return `http://localhost:8080/download/${path.basename(filePath)}`;
        } catch (error) {
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    cleanup(outputDir, zipPath) {
        try {
            // Remove build directory
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
            
            // Remove ZIP after a delay
            setTimeout(() => {
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                }
            }, 3600000); // 1 hour
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }

    sendProgress(ws, requestId, message, progress) {
        ws.send(JSON.stringify({
            type: 'build_progress',
            requestId,
            message,
            progress
        }));
    }

    sendComplete(ws, requestId, downloadUrl) {
        ws.send(JSON.stringify({
            type: 'build_complete',
            requestId,
            downloadUrl
        }));
    }

    sendError(ws, requestId, error) {
        ws.send(JSON.stringify({
            type: 'build_error',
            requestId,
            error
        }));
    }
}

// Start the bridge
new BuildBridge();

