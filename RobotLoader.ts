/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import { MujocoModule } from "./types";

const MENAGERIE_ASSET_ROOT = `${import.meta.env.BASE_URL}menagerie/`;

/**
 * RobotLoader
 * Handles fetching robot XML files and their dependencies (meshes, textures) from remote URLs.
 * It writes these files into MuJoCo's in-memory virtual filesystem so the C++ engine can read them.
 */
export class RobotLoader {
    private mujoco: MujocoModule;

    constructor(mujocoInstance: MujocoModule) {
        this.mujoco = mujocoInstance;
    }

    private buildSpreadWorkspaceSeeds() {
        const seeds = [
            { x: 0.36, y: 0.00 },   // front
            { x: 0.28, y: 0.22 },   // front-left
            { x: 0.28, y: -0.22 },  // front-right
            { x: 0.14, y: 0.34 },   // left
            { x: 0.14, y: -0.34 },  // right
            { x: 0.06, y: 0.20 },   // rear-left
            { x: 0.06, y: -0.20 },  // rear-right
            { x: 0.08, y: 0.00 },   // rear
            { x: 0.22, y: 0.10 },   // mid-left
            { x: 0.22, y: -0.10 },  // mid-right
        ];

        return seeds
            .map((seed) => ({
                x: seed.x + (Math.random() - 0.5) * 0.05,
                y: seed.y + (Math.random() - 0.5) * 0.05,
                sort: Math.random(),
            }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ x, y }) => ({ x, y }));
    }

    /**
     * Main entry point. Downloads the main scene XML and recursively finds/downloads all included files.
     * @param onProgress Optional callback to report loading progress string.
     */
    async load(robotId: string, sceneFile: string, onProgress?: (msg: string) => void): Promise<{ isDouble: boolean, isStacking: boolean }> {
        // 1. Clean up the virtual filesystem from previous runs
        try { this.mujoco.FS.unmount('/working'); } catch (e) { /* ignore */ }
        try { this.mujoco.FS.mkdir('/working'); } catch (e) { /* ignore */ }

        const isDouble = false;
        const isStacking = robotId === 'franka_panda_stack';
        // Prefer local static assets so mesh/texture files are cached by the app
        // instead of being fetched from GitHub on every load.
        const currentRobotId = isStacking ? 'franka_emika_panda' : robotId;
        const baseUrl = `${MENAGERIE_ASSET_ROOT}${currentRobotId}/`;

        const downloaded = new Set<string>(); // Keep track to avoid re-downloading same file twice
        const queue: Array<string> = []; // Queue of files to process
        const parser = new DOMParser(); // For parsing XML to find dependencies

        queue.push(sceneFile);

        // Process queue until all dependencies are downloaded
        while (queue.length > 0) {
            const fname = queue.shift()!;
            if (downloaded.has(fname)) continue;
            downloaded.add(fname);

            if (onProgress) {
                onProgress(`Downloading ${fname}...`);
            }

            // Fetch file from network
            const res = await fetch(baseUrl + fname);
            if (!res.ok) {
                console.warn(`Failed to fetch ${fname}: ${res.status} ${res.statusText}`);
                continue;
            }

            // Ensure virtual directory structure exists (e.g., /working/assets/meshes/)
            const dirParts = fname.split('/');
            dirParts.pop(); // remove filename
            let currentPath = '/working';
            for (const part of dirParts) {
                currentPath += '/' + part;
                try { this.mujoco.FS.mkdir(currentPath); } catch (e) { /* ignore */ }
            }

            // If it's an XML, we might need to patch it and scan it for more dependencies
            if (fname.endsWith('.xml')) {
                let text = await res.text();
                text = this.patchSingleRobot(fname, sceneFile, isStacking, text);
                
                // Write text file to virtual FS
                this.mujoco.FS.writeFile(`/working/${fname}`, text);
                // Scan for <include file="...">, <mesh file="...">, etc.
                this.scanDependencies(text, fname, parser, downloaded, queue);
            } else {
                // Binary files (STL, PNG) just get written directly
                const buffer = new Uint8Array(await res.arrayBuffer());
                this.mujoco.FS.writeFile(`/working/${fname}`, buffer);
            }
        }
        return { isDouble, isStacking };
    }

    // Modifies the standard XMLs to add our specific demo objects (cubes, trays)
    private patchSingleRobot(fname: string, sceneFile: string, isStacking: boolean, text: string): string {
        if (fname === sceneFile) {
            let injection = '';
            if (isStacking) {
                const colors = [
                    '0.8 0.1 0.1 1', // Red
                    '0.0 0.8 0.8 1', // Cyan (Changed from Blue)
                    '0.1 0.8 0.1 1', // Green
                    '0.8 0.8 0.1 1'  // Yellow
                ];
                
                const positions: {x: number, y: number}[] = [];
                const spreadSeeds = this.buildSpreadWorkspaceSeeds();
                
                // Inject cubes across a broader reachable workspace so pickup order has a larger effect.
                for (let i = 0; i < 6; i++) {
                    let x = 0;
                    let y = 0;
                    let valid = false;
                    let attempts = 0;
                    
                    while (!valid && attempts < 200) {
                        const seed = spreadSeeds[(i + attempts) % spreadSeeds.length];
                        x = seed.x + (Math.random() - 0.5) * 0.03;
                        y = seed.y + (Math.random() - 0.5) * 0.03;
                        
                        valid = true;
                        
                        // Spread cubes around the robot while avoiding the tray and the immediate base neighborhood.
                        const distStack = Math.sqrt((x - 0.6)**2 + y**2);
                        const distRobot = Math.sqrt(x**2 + y**2);
                        if (distStack < 0.18 || distRobot < 0.1 || distRobot > 0.42) valid = false;

                        // Avoid other cubes
                        if (valid) {
                            for (const p of positions) {
                                const d2 = (p.x - x)**2 + (p.y - y)**2;
                                if (d2 < 0.0081) { // 9cm separation for clearer order-sensitive travel
                                    valid = false; 
                                    break; 
                                }
                            }
                        }
                        attempts++;
                    }

                    if (valid) {
                        positions.push({x, y});
                        const color = colors[i % 4];
                        injection += `<body name="cube${i}" pos="${x.toFixed(3)} ${y.toFixed(3)} 0.02"><freejoint/><geom type="box" size="0.02 0.02 0.02" rgba="${color}" mass="0.05" friction="1.5 0.3 0.1" solref="0.01 1" solimp="0.95 0.99 0.001 0.5 2" condim="4"/></body>`;
                    }
                }
                // Increased stack_base size from 0.05 to 0.1 (2x width/length) - now 20cm x 20cm tray
                injection += `<body name="stack_base" pos="0.6 0 0.0"><geom type="box" size="0.1 0.1 0.005" rgba="0.3 0.3 0.3 1"/></body>`;
            } else {
                 // Inject single cube and tray
                 // Tray size doubled from 0.08 to 0.16. Walls adjusted accordingly.
                injection = `<body name="cube" pos="0.4 -0.1 0.04"><freejoint/><geom type="box" size="0.02 0.02 0.02" rgba="1 0 0 1" mass="0.05" friction="2 0.3 0.1" solref="0.01 1" solimp="0.95 0.99 0.001 0.5 2" condim="4"/></body><body name="tray" pos="0.4 0.2 0.0"><geom type="box" size="0.16 0.16 0.005" pos="0 0 0.005" rgba="0.8 0.8 0.8 1"/><geom type="box" size="0.16 0.005 0.02" pos="0 0.16 0.02" rgba="0.8 0.8 0.8 1"/><geom type="box" size="0.005 0.16 0.02" pos="-0.16 0 0.02" rgba="0.8 0.8 0.8 1"/></body>`;
            }
            text = text.replace('</worldbody>', injection + '</worldbody>');
        }
        // Ensure Panda has a named gripper actuator and a TCP site for IK
        if (fname.endsWith('panda.xml')) {
            text = text.replace(/(<body[^>]*name=["']hand["'][^>]*>)/, '$1<site name="tcp" pos="0 0 0.1" size="0.01" rgba="1 0 0 0.5" group="1"/>').replace(/name=["']actuator8["']/, 'name="gripper"');
        }
        return text;
    }

    // Finds all files referenced in the XML so we can download them too
    private scanDependencies(xmlString: string, currentFile: string, parser: DOMParser, downloaded: Set<string>, queue: string[]) {
        const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
        
        // Check if the XML defines specific directories for assets
        const compiler = xmlDoc.querySelector('compiler');
        const meshDir = compiler?.getAttribute('meshdir') || '';
        const textureDir = compiler?.getAttribute('texturedir') || '';
        
        // Calculate relative path of current file
        const currentDir = currentFile.includes('/') ? currentFile.substring(0, currentFile.lastIndexOf('/') + 1) : '';

        // Find all elements with a 'file' attribute
        xmlDoc.querySelectorAll('[file]').forEach(el => {
            const fileAttr = el.getAttribute('file');
            if (!fileAttr) return;
            
            // Prepend appropriate directory based on tag type
            let prefix = '';
            if (el.tagName.toLowerCase() === 'mesh') {
                prefix = meshDir ? meshDir + '/' : '';
            } else if (['texture', 'hfield'].includes(el.tagName.toLowerCase())) {
                prefix = textureDir ? textureDir + '/' : '';
            }
            
            // Normalize path (resolve '..' and '.')
            let fullPath = (currentDir + prefix + fileAttr).replace(/\/\//g, '/');
            const parts = fullPath.split('/');
            const norm: string[] = [];
            for (const p of parts) { if (p === '..') norm.pop(); else if (p !== '.') norm.push(p); }
            fullPath = norm.join('/');
            
            // Add to queue if we haven't seen it yet
            if (!downloaded.has(fullPath)) queue.push(fullPath);
        });
    }
}
