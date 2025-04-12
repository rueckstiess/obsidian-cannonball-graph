import { Plugin, Notice } from 'obsidian';
import { KuzuClient } from './kuzu-client';
import KuzuWorker from 'kuzu.worker';
import { ObsidianCacheGraphService } from './ObsidianCacheGraphService';

export default class KuzuPlugin extends Plugin {
	private kuzuClient: KuzuClient;
	private graphService: ObsidianCacheGraphService;
	private isReady = false;

	/**
	 * Encodes ArrayBuffer to Base64 string for storage.
	 */
	private bufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunkSize = 0x8000; // 32KB per chunk
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	}

	/**
	 * Decodes Base64 string to ArrayBuffer.
	 */
	private base64ToBuffer(base64: string): ArrayBuffer {
		const binary = atob(base64);
		const length = binary.length;
		const bytes = new Uint8Array(length);

		// Optimize by avoiding charCodeAt calls when possible
		for (let i = 0; i < length; ++i) {
			bytes[i] = binary.charCodeAt(i) & 0xff;
		}

		return bytes.buffer;
	}

	async onload() {
		try {
			// Create the KuzuDB client
			this.kuzuClient = new KuzuClient(KuzuWorker);

			// Load saved database data (if any)
			const saved = await this.loadData();
			let dbData: ArrayBuffer | undefined;

			if (saved && saved.dbData) {
				console.log('Found saved database data');
				dbData = this.base64ToBuffer(saved.dbData);
			}

			// Initialize the database
			await this.kuzuClient.init(dbData);
			this.isReady = true;

			console.log('KuzuDB initialized successfully');

			// Add plugin commands
			this.addCommands();

			// Add status bar item to show database status
			this.addStatusBarItem().setText('KuzuDB: Ready');

			// Initialize Cache Graph Service
			this.graphService = new ObsidianCacheGraphService(this, this.kuzuClient);

			new Notice('cannonball-graph plugin loaded successfully');
		} catch (error) {
			console.error('Failed to initialize KuzuDB:', error);
			new Notice(`KuzuDB initialization failed: ${error.message}`);
		}
	}

	/**
	 * Adds plugin commands to Obsidian.
	 */
	private addCommands() {
		// Command to create schema
		this.addCommand({
			id: 'kuzu-init-schema',
			name: 'Initialize Schema',
			callback: async () => {
				try {
					await this.ensureReady();
					// The schema is now automatically initialized in the service
					new Notice('Schema initialized successfully');
				} catch (error) {
					console.error('Failed to initialize schema:', error);
					new Notice(`Schema initialization failed: ${error.message}`);
				}
			}
		});

		// Add command to reindex the current file
		this.addCommand({
			id: 'kuzu-reindex-file',
			name: 'Reindex Current File',
			callback: async () => {
				try {
					await this.ensureReady();
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile) {
						await this.graphService.processFile(activeFile);
						new Notice(`Reindexed file: ${activeFile.path}`);
					} else {
						new Notice('No active file to reindex');
					}
				} catch (error) {
					console.error('Failed to reindex file:', error);
					new Notice(`Reindexing failed: ${error.message}`);
				}
			}
		})

		// Add a command to manually reindex the entire vault
		this.addCommand({
			id: "reindex-vault",
			name: "Reindex all files in vault",
			callback: async () => {
				try {
					await this.ensureReady();
					await this.graphService.indexVault();
					new Notice('Vault reindexing complete');
				} catch (error) {
					console.error('Failed to reindex vault:', error);
					new Notice(`Reindexing failed: ${error.message}`);
				}
			}
		});

		// Add a command to show database contents
		this.addCommand({
			id: "show-database-contents",
			name: "Show Database Contents",
			callback: async () => {
				try {
					await this.ensureReady();
					const result = await this.kuzuClient.query(
						"MATCH (b:Block) RETURN b.type as type, b.text as text, b.line as line LIMIT 25"
					);
					console.log('Database contents:', result);
					new Notice(`Found ${result.length} blocks in database`);
				} catch (error) {
					console.error('Failed to query blocks:', error);
					new Notice(`Query failed: ${error.message}`);
				}
			}
		});
	}

	/**
		 * Persists the database to storage.
		 */
	private async persistDatabase(): Promise<void> {
		try {
			const files = await this.kuzuClient.persist();
			// Check if we got any files back
			if (Object.keys(files).length === 0) {
				console.warn("No database files returned during persist operation!");
			}
			const json = JSON.stringify(files);
			const bytes = new TextEncoder().encode(json);
			const base64 = this.bufferToBase64(bytes);
			await this.saveData(base64);
			console.log('Database persisted successfully');
		} catch (error) {
			console.error('Failed to persist database:', error);
			throw error;
		}
	}

	/**
	 * Ensures the database is initialized before running operations.
	 */
	private async ensureReady(): Promise<void> {
		if (!this.isReady) {
			throw new Error('KuzuDB is not initialized');
		}

		// Verify database health
		const isHealthy = await this.kuzuClient.isHealthy();
		if (!isHealthy) {
			throw new Error('KuzuDB is not responding');
		}
	}

	async onunload() {
		console.log('Unloading KuzuDB plugin');

		if (this.kuzuClient) {
			try {
				// Persist database before unloading
				await this.persistDatabase();

				// Close the connection
				await this.kuzuClient.close();

				console.log('KuzuDB closed successfully');
			} catch (error) {
				console.error('Error closing KuzuDB:', error);
			}
		}
	}
}