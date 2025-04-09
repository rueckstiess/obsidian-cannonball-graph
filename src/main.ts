import { Plugin, Notice } from 'obsidian';
import KuzuWorker from 'kuzu.worker';  // import the inline worker

function bufferToBase64(buffer: ArrayBuffer): string {
	const binary = String.fromCharCode(...new Uint8Array(buffer));
	return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export default class KuzuPlugin extends Plugin {
	worker: Worker;

	async onload() {
		this.worker = new KuzuWorker();
		this.worker.onmessage = (event) => {
			const msg = event.data;
			if (msg.type === 'query-result') {
				console.log("Query result (JSON):", msg.result);
				new Notice("Query Result: " + msg.result);  // display result
			} else if (msg.type === 'insert-result') {
				new Notice("Insert succeeded: " + msg.result);
			} else if (msg.type === 'error') {
				console.error("Kuzu error:", msg.error);
				new Notice("Kuzu Error: " + msg.error);
			} else if (msg.type === 'persist-data') {
				// Received DB bytes for persistence
				const bytes: ArrayBuffer = msg.buffer;
				const base64 = bufferToBase64(bytes);
				this.saveData(base64);
			}
		};
		// Initialize the worker (send saved DB if exists)
		const saved = await this.loadData();
		const initMsg: any = { type: 'init' };
		if (saved) {
			// Convert base64 back to ArrayBuffer
			initMsg.dbData = base64ToBuffer(saved);
		}
		this.worker.postMessage(initMsg);

		// (Optional) Add commands or UI to use the database
		this.addCommand({
			id: 'kuzu-sample-query',
			name: 'Kuzu: Run Sample Query',
			callback: () => {
				// Example: create a table, insert, then query
				this.worker.postMessage({
					type: 'query', cypher:
						'CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name));'
				});
				this.worker.postMessage({
					type: 'insert', cypher:
						"CREATE (:Person {name: 'Alice', age: 30});"
				});
				this.worker.postMessage({
					type: 'query', cypher:
						'MATCH (p:Person) RETURN p.name, p.age;'
				});
			}
		});
	}

	onunload() {
		// On unload, ask worker to persist data and terminate it
		this.worker.postMessage({ type: 'persist' });
		this.worker.terminate();
	}
}