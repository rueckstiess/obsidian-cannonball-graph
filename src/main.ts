import { Plugin, Notice } from 'obsidian';
import { KuzuClient } from './kuzu-client';
import KuzuWorker from 'kuzu.worker';

export default class KuzuPlugin extends Plugin {
	private kuzuClient: KuzuClient;
	private isReady = false;

	/**
	 * Encodes ArrayBuffer to Base64 string for storage.
	 */
	private bufferToBase64(buffer: ArrayBuffer): string {
		const binary = String.fromCharCode(...new Uint8Array(buffer));
		return btoa(binary);
	}

	/**
	 * Decodes Base64 string to ArrayBuffer.
	 */
	private base64ToBuffer(base64: string): ArrayBuffer {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes.buffer;
	}

	async onload() {
		console.log('Loading KuzuDB plugin');

		try {
			// Create the KuzuDB client
			this.kuzuClient = new KuzuClient(KuzuWorker);

			// Load saved database data (if any)
			const saved = await this.loadData();
			let dbData: ArrayBuffer | undefined;

			if (saved) {
				console.log('Found saved database data');
				dbData = this.base64ToBuffer(saved);
			}

			// Initialize the database
			await this.kuzuClient.init(dbData);
			this.isReady = true;
			console.log('KuzuDB initialized successfully');

			// Add plugin commands
			this.addCommands();

			// Add status bar item to show database status
			this.addStatusBarItem().setText('KuzuDB: Ready');

			new Notice('KuzuDB plugin loaded successfully');
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
					await this.kuzuClient.transaction([
						// Create node tables
						'CREATE NODE TABLE IF NOT EXISTS Person(name STRING, age INT64, PRIMARY KEY(name))',
						'CREATE NODE TABLE IF NOT EXISTS Note(path STRING, title STRING, created TIMESTAMP, PRIMARY KEY(path))',

						// Create edge tables
						'CREATE REL TABLE IF NOT EXISTS REFERENCES(FROM Note TO Note, context STRING)'
					]);

					// Persist changes
					await this.persistDatabase();

					new Notice('Schema initialized successfully');
				} catch (error) {
					console.error('Failed to initialize schema:', error);
					new Notice(`Schema initialization failed: ${error.message}`);
				}
			}
		});

		// Command to insert test data
		this.addCommand({
			id: 'kuzu-insert-test-data',
			name: 'Insert Test Data',
			callback: async () => {
				try {
					await this.ensureReady();
					await this.kuzuClient.transaction([
						// Insert people
						"CREATE (:Person {name: 'Alice', age: 30})",
						"CREATE (:Person {name: 'Bob', age: 42})",
						"CREATE (:Person {name: 'Charlie', age: 25})",

						// Insert notes
						"CREATE (:Note {path: '/notes/test1.md', title: 'Test Note 1', created: datetime()})",
						"CREATE (:Note {path: '/notes/test2.md', title: 'Test Note 2', created: datetime()})"
					]);

					// Create relationships
					await this.kuzuClient.transaction([
						"MATCH (a:Note {path: '/notes/test1.md'}), (b:Note {path: '/notes/test2.md'}) " +
						"CREATE (a)-[:REFERENCES {context: 'Referenced in section 2'}]->(b)"
					]);

					// Persist changes
					await this.persistDatabase();

					new Notice('Test data inserted successfully');
				} catch (error) {
					console.error('Failed to insert test data:', error);
					new Notice(`Test data insertion failed: ${error.message}`);
				}
			}
		});

		// Command to query people
		this.addCommand({
			id: 'kuzu-query-people',
			name: 'Query People',
			callback: async () => {
				try {
					await this.ensureReady();
					const result = await this.kuzuClient.query('MATCH (p:Person) RETURN p.name, p.age ORDER BY p.name');
					console.log('Main query result:', result);

					// // Format results for display
					// const formattedResult = result.map((row: any) =>
					// 	`${row['p.name']}: ${row['p.age']} years old`
					// ).join('\n');

					// new Notice(`People in database:\n${formattedResult}`, 5000);
				} catch (error) {
					console.error('Failed to query people:', error);
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