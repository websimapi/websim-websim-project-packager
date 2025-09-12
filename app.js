class ProjectPackager {
    constructor() {
        this.room = null;
        this.isCreator = false;
        this.creator = null;
        this.selectedProject = null;
        this.bridgeSocket = null;
        this.projects = [];
        
        this.init();
    }

    async init() {
        try {
            // Initialize WebSim room
            this.room = new WebsimSocket();
            await this.room.initialize();

            // Get creator info
            this.creator = await window.websim.getCreator();
            const currentUser = await window.websim.getUser();
            
            this.isCreator = currentUser && this.creator && currentUser.id === this.creator.id;

            // Set up event handlers
            this.setupEventHandlers();
            
            // Initialize interface
            this.initializeInterface();
            
            if (this.isCreator) {
                await this.loadCreatorProjects();
                this.connectToBridge();
            } else {
                await this.loadProjects();
            }

            this.updateConnectionStatus('connected');
            
        } catch (error) {
            console.error('Failed to initialize:', error);
            this.updateConnectionStatus('error');
        }
    }

    setupEventHandlers() {
        // Room state and presence subscriptions
        this.room.subscribePresence((presence) => {
            this.updateUsersList();
        });

        this.room.subscribeRoomState((roomState) => {
            this.handleRoomStateUpdate(roomState);
        });

        this.room.subscribePresenceUpdateRequests((request, fromClientId) => {
            this.handlePresenceUpdateRequest(request, fromClientId);
        });

        // Message handling
        this.room.onmessage = (event) => {
            this.handleMessage(event.data);
        };

        // UI event handlers
        document.getElementById('buildButton')?.addEventListener('click', () => {
            this.requestBuild();
        });

        // Bridge download handler
        document.getElementById('downloadBridge')?.addEventListener('click', () => {
            this.downloadBridgePackage();
        });

        // Project selection
        document.addEventListener('click', (e) => {
            const projectCard = e.target.closest('.project-card');
            if (projectCard) {
                this.selectProject(projectCard.dataset.projectId);
            }
        });
    }

    initializeInterface() {
        const loadingState = document.getElementById('loadingState');
        const creatorInterface = document.getElementById('creatorInterface');
        const userInterface = document.getElementById('userInterface');

        loadingState.style.display = 'none';

        if (this.isCreator) {
            creatorInterface.style.display = 'grid';
            this.updateBridgeStatus('disconnected');
        } else {
            userInterface.style.display = 'block';
            this.displayCreatorInfo();
        }

        this.updateUsersList();
    }

    async loadCreatorProjects() {
        try {
            const response = await fetch('/api/v1/users/' + this.creator.username + '/projects');
            const data = await response.json();
            this.projects = data.projects?.data || [];
        } catch (error) {
            console.error('Failed to load creator projects:', error);
            this.projects = [];
        }
    }

    async loadProjects() {
        if (!this.creator) return;

        try {
            const response = await fetch('/api/v1/users/' + this.creator.username + '/projects');
            const data = await response.json();
            this.projects = data.projects?.data || [];
            this.displayProjects();
        } catch (error) {
            console.error('Failed to load projects:', error);
            this.displayProjectsError();
        }
    }

    displayCreatorInfo() {
        if (!this.creator) return;

        const creatorInfo = document.getElementById('creatorInfo');
        creatorInfo.innerHTML = `
            <img src="https://images.websim.com/avatar/${this.creator.username}" 
                 alt="${this.creator.username}" class="creator-avatar">
            <div>
                <h3>Projects by @${this.creator.username}</h3>
                <p>Select a project to package as a desktop application</p>
            </div>
        `;
    }

    displayProjects() {
        const projectsGrid = document.getElementById('projectsGrid');
        
        if (this.projects.length === 0) {
            projectsGrid.innerHTML = '<div class="empty-state">No projects available</div>';
            return;
        }

        projectsGrid.innerHTML = this.projects.map(project => `
            <div class="project-card" data-project-id="${project.id}">
                <img src="https://images.websim.com/v1/site/${project.id}/600" 
                     alt="${project.title}" class="project-image"
                     onerror="this.style.display='none'">
                <div class="project-info">
                    <h4 class="project-title">${project.title}</h4>
                    <p class="project-description">${project.description || 'No description available'}</p>
                </div>
            </div>
        `).join('');
    }

    displayProjectsError() {
        const projectsGrid = document.getElementById('projectsGrid');
        projectsGrid.innerHTML = '<div class="empty-state">Failed to load projects</div>';
    }

    selectProject(projectId) {
        const project = this.projects.find(p => p.id === projectId);
        if (!project) return;

        this.selectedProject = project;

        // Update UI
        document.querySelectorAll('.project-card').forEach(card => {
            card.classList.remove('selected');
        });
        document.querySelector(`[data-project-id="${projectId}"]`).classList.add('selected');

        // Show build section
        const buildSection = document.getElementById('buildSection');
        const selectedProjectDiv = document.getElementById('selectedProject');
        
        selectedProjectDiv.innerHTML = `
            <h4>${project.title}</h4>
            <p>${project.description || 'No description available'}</p>
            <small>Project ID: ${project.id}</small>
        `;
        
        buildSection.style.display = 'block';
    }

    requestBuild() {
        if (!this.selectedProject) return;

        const platform = document.querySelector('input[name="platform"]:checked')?.value;
        if (!platform) return;

        const buildRequest = {
            type: 'build_request',
            project: this.selectedProject,
            platform: platform,
            requestId: Date.now().toString(),
            username: this.room.peers[this.room.clientId]?.username || 'Anonymous'
        };

        // Send to creator
        this.room.send({
            type: 'build_request',
            ...buildRequest,
            echo: false
        });

        // Update UI
        this.showBuildStatus('Build requested... Waiting for creator response', 10);
        document.getElementById('buildButton').disabled = true;
    }

    showBuildStatus(message, progress = 0) {
        const buildStatus = document.getElementById('buildStatus');
        const statusMessage = document.getElementById('statusMessage');
        const progressFill = document.getElementById('progressFill');

        statusMessage.textContent = message;
        progressFill.style.width = `${progress}%`;
        buildStatus.style.display = 'block';
    }

    connectToBridge() {
        try {
            this.bridgeSocket = new WebSocket('ws://localhost:8080');
            
            this.bridgeSocket.onopen = () => {
                this.updateBridgeStatus('connected');
            };

            this.bridgeSocket.onclose = () => {
                this.updateBridgeStatus('disconnected');
                // Attempt reconnection after 5 seconds
                setTimeout(() => this.connectToBridge(), 5000);
            };

            this.bridgeSocket.onerror = () => {
                this.updateBridgeStatus('error');
            };

            this.bridgeSocket.onmessage = (event) => {
                this.handleBridgeMessage(JSON.parse(event.data));
            };

        } catch (error) {
            this.updateBridgeStatus('error');
        }
    }

    updateBridgeStatus(status) {
        const indicator = document.getElementById('bridgeIndicator');
        const text = document.getElementById('bridgeStatusText');

        indicator.className = `status-indicator ${status === 'connected' ? 'connected' : ''}`;
        
        const statusTexts = {
            connected: 'Connected',
            disconnected: 'Disconnected',
            error: 'Connection Error'
        };
        
        text.textContent = statusTexts[status] || 'Unknown';
    }

    handleMessage(data) {
        switch (data.type) {
            case 'build_request':
                if (this.isCreator) {
                    this.handleBuildRequest(data);
                }
                break;
            case 'build_update':
                this.handleBuildUpdate(data);
                break;
            case 'build_complete':
                this.handleBuildComplete(data);
                break;
            case 'build_error':
                this.handleBuildError(data);
                break;
        }
    }

    handleBuildRequest(request) {
        if (!this.bridgeSocket || this.bridgeSocket.readyState !== WebSocket.OPEN) {
            this.room.send({
                type: 'build_error',
                requestId: request.requestId,
                error: 'Build bridge not connected',
                echo: false
            });
            return;
        }

        // Add to queue display
        this.addToQueue(request);

        // Forward to bridge
        const bridgeRequest = {
            type: 'build',
            url: `https://${request.project.id}--${this.creator.username}.on.websim.com`,
            platform: request.platform,
            projectName: request.project.title.replace(/[^a-zA-Z0-9]/g, ''),
            requestId: request.requestId
        };

        this.bridgeSocket.send(JSON.stringify(bridgeRequest));

        // Notify user that build started
        this.room.send({
            type: 'build_update',
            requestId: request.requestId,
            message: 'Build started...',
            progress: 20,
            echo: false
        });
    }

    addToQueue(request) {
        const queueList = document.getElementById('queueList');
        const emptyState = queueList.querySelector('.empty-state');
        
        if (emptyState) {
            emptyState.remove();
        }

        const queueItem = document.createElement('div');
        queueItem.className = 'queue-item';
        queueItem.dataset.requestId = request.requestId;
        queueItem.innerHTML = `
            <div>
                <div class="project-name">${request.project.title}</div>
                <div>Requested by: ${request.username}</div>
            </div>
            <div class="platform">${request.platform}</div>
        `;

        queueList.appendChild(queueItem);
    }

    removeFromQueue(requestId) {
        const queueItem = document.querySelector(`[data-request-id="${requestId}"]`);
        if (queueItem) {
            queueItem.remove();
        }

        const queueList = document.getElementById('queueList');
        if (queueList.children.length === 0) {
            queueList.innerHTML = '<div class="empty-state">No pending builds</div>';
        }
    }

    handleBridgeMessage(data) {
        switch (data.type) {
            case 'build_progress':
                this.room.send({
                    type: 'build_update',
                    requestId: data.requestId,
                    message: data.message,
                    progress: data.progress,
                    echo: false
                });
                break;
            case 'build_complete':
                this.removeFromQueue(data.requestId);
                this.room.send({
                    type: 'build_complete',
                    requestId: data.requestId,
                    downloadUrl: data.downloadUrl,
                    echo: false
                });
                break;
            case 'build_error':
                this.removeFromQueue(data.requestId);
                this.room.send({
                    type: 'build_error',
                    requestId: data.requestId,
                    error: data.error,
                    echo: false
                });
                break;
        }
    }

    handleBuildUpdate(data) {
        if (!this.isCreator) {
            this.showBuildStatus(data.message, data.progress);
        }
    }

    handleBuildComplete(data) {
        if (!this.isCreator) {
            this.showBuildStatus('Build complete! Download ready.', 100);
            
            // Create download link
            setTimeout(() => {
                const buildStatus = document.getElementById('buildStatus');
                buildStatus.innerHTML += `
                    <div style="margin-top: 1rem;">
                        <a href="${data.downloadUrl}" download class="build-button" style="display: inline-block; text-decoration: none; text-align: center;">
                            Download Application
                        </a>
                    </div>
                `;
            }, 1000);
        }
    }

    handleBuildError(data) {
        if (!this.isCreator) {
            this.showBuildStatus(`Build failed: ${data.error}`, 0);
            document.getElementById('buildButton').disabled = false;
        }
    }

    updateUsersList() {
        const usersList = document.getElementById('usersList');
        if (!usersList) return;

        const users = Object.values(this.room.peers).filter(peer => peer.id !== this.room.clientId);
        
        if (users.length === 0) {
            usersList.innerHTML = '<div class="empty-state">No users connected</div>';
            return;
        }

        usersList.innerHTML = users.map(user => `
            <div class="user-item">
                <img src="https://images.websim.com/avatar/${user.username}" 
                     alt="${user.username}" class="user-avatar">
                <span>@${user.username}</span>
            </div>
        `).join('');
    }

    updateConnectionStatus(status) {
        const indicator = document.querySelector('.connection-status .status-indicator');
        const text = document.querySelector('.connection-status span');

        indicator.className = `status-indicator ${status === 'connected' ? 'connected' : status}`;
        
        const statusTexts = {
            connected: 'Connected',
            connecting: 'Connecting...',
            error: 'Connection Error'
        };
        
        text.textContent = statusTexts[status] || 'Unknown';
    }

    handleRoomStateUpdate(roomState) {
        // Handle any room state updates if needed
    }

    handlePresenceUpdateRequest(request, fromClientId) {
        // Handle presence update requests if needed
    }

    downloadBridgePackage() {
        // Create the bridge files as a ZIP
        const zip = new JSZip();
        
        // Add package.json
        const packageJson = {
            "name": "websim-build-bridge",
            "version": "1.0.0",
            "description": "Node.js bridge for building WebSim projects",
            "main": "bridge.js",
            "scripts": {
                "start": "node bridge.js"
            },
            "dependencies": {
                "ws": "^8.13.0",
                "archiver": "^5.3.1"
            },
            "devDependencies": {
                "nativefier": "^50.0.0"
            }
        };
        
        zip.file("package.json", JSON.stringify(packageJson, null, 2));
        
        // Add bridge.js
        const bridgeJs = `const WebSocket = require('ws');
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
                        'Content-Disposition': \`attachment; filename="\${fileName}"\`,
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
        const zipFileName = \`\${projectName}-\${platform}.zip\`;
        const zipPath = path.join(__dirname, 'builds', zipFileName);

        try {
            if (!fs.existsSync(path.join(__dirname, 'builds'))) {
                fs.mkdirSync(path.join(__dirname, 'builds'));
            }

            this.sendProgress(ws, requestId, 'Preparing build environment...', 30);

            const arch = 'x64';
            const command = \`npx nativefier "\${url}" --name "\${projectName}" --platform "\${platform}" --arch "\${arch}" --out "\${outputDir}" --overwrite\`;

            console.log('Running command:', command);
            
            this.sendProgress(ws, requestId, 'Building application...', 60);

            exec(command, { timeout: 300000 }, async (error, stdout, stderr) => {
                if (error) {
                    console.error('Build error:', stderr || stdout || error);
                    this.sendError(ws, requestId, \`Build failed: \${error.message}\`);
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
                    
                    const downloadUrl = \`http://localhost:8081/download/\${zipFileName}\`;
                    this.sendComplete(ws, requestId, downloadUrl);
                    this.sendProgress(ws, requestId, 'Build complete!', 100);

                    // Note: Cleanup is handled by the bridge itself after a delay.

                } catch (zipError) {
                    console.error('Compression/Packaging error:', zipError);
                    this.sendError(ws, requestId, \`Packaging failed: \${zipError.message}\`);
                }
            });

        } catch (setupError) {
            console.error('Build setup error:', setupError);
            this.sendError(ws, requestId, \`Build setup failed: \${setupError.message}\`);
        }
    }

    createZip(sourceDir, outputPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => {
                console.log(\`ZIP created: \${archive.pointer()} total bytes\`);
                resolve();
            });
            output.on('error', (err) => reject(err));
            archive.on('error', (err) => reject(err));

            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
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
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ProjectPackager();
});