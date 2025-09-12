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
        const zipPath = path.join(__dirname, 'builds', \`\${projectName}-\${platform}.zip\`);

        try {
            if (!fs.existsSync(path.join(__dirname, 'builds'))) {
                fs.mkdirSync(path.join(__dirname, 'builds'));
            }

            this.sendProgress(ws, requestId, 'Preparing build environment...', 30);

            const arch = platform === 'darwin' ? 'x64' : 'x64';
            const command = \`npx nativefier "\${url}" --name "\${projectName}" --platform "\${platform}" --arch "\${arch}" --out "\${outputDir}" --overwrite\`;

            console.log('Running command:', command);
            
            this.sendProgress(ws, requestId, 'Building application...', 60);

            exec(command, { timeout: 300000 }, async (error, stdout, stderr) => {
                if (error) {
                    console.error('Build error:', error);
                    this.sendError(ws, requestId, \`Build failed: \${error.message}\`);
                    return;
                }

                try {
                    this.sendProgress(ws, requestId, 'Compressing application...', 80);

                    const builtAppDir = this.findBuiltApp(outputDir, projectName);
                    if (!builtAppDir) {
                        throw new Error('Built application not found');
                    }

                    await this.createZip(builtAppDir, zipPath);
                    this.sendProgress(ws, requestId, 'Upload complete!', 100);

                    const downloadUrl = await this.uploadFile(zipPath);
                    this.sendComplete(ws, requestId, downloadUrl);
                    this.cleanup(outputDir, zipPath);

                } catch (zipError) {
                    console.error('Compression error:', zipError);
                    this.sendError(ws, requestId, \`Compression failed: \${zipError.message}\`);
                }
            });

        } catch (error) {
            console.error('Build setup error:', error);
            this.sendError(ws, requestId, \`Build setup failed: \${error.message}\`);
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
                console.log(\`ZIP created: \${archive.pointer()} total bytes\`);
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
        try {
            const fileBuffer = fs.readFileSync(filePath);
            const file = new File([fileBuffer], path.basename(filePath), { type: 'application/zip' });
            return \`http://localhost:8080/download/\${path.basename(filePath)}\`;
        } catch (error) {
            throw new Error(\`Upload failed: \${error.message}\`);
        }
    }

    cleanup(outputDir, zipPath) {
        try {
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
            
            setTimeout(() => {
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                }
            }, 3600000);
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

new BuildBridge();
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ProjectPackager();
});