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

		// Initialize the worker (send saved DB if exists)
		console.log("Main thread - onload")
		const saved = await this.loadData();
		console.log("Main thread - loadData()", saved);
		const initMsg: any = { type: 'init' };
		if (saved) {
			initMsg.dbData = base64ToBuffer(saved);
		}
		this.worker.postMessage(initMsg);

		// Listen for messages from the worker
		this.worker.onmessage = (event) => {
			const msg = event.data;

			switch (msg.type) {

				case 'init-done':
					console.log("Main thread - init-done");
					console.log("Kuzu worker initialized");
					break;

				case 'query-done':
					console.log("Main thread - query-done");
					console.log("Query result (JSON):", msg.result);
					break;

				case 'insert-done':
					console.log("Main thread - insert-done");
					break;

				case 'persist-done': {
					console.log("Main thread - persist-done");
					const json = JSON.stringify(msg.files);
					const bytes = new TextEncoder().encode(json);
					const base64 = bufferToBase64(bytes);
					this.saveData(base64);
					break;
				}

				case 'error':
					console.log("Main thread - error");
					console.error("Kuzu error:", msg.error);
					new Notice("Kuzu Error: " + msg.error);
					break;

			}
		};

		this.addCommand({
			id: 'kuzu-insert-bob',
			name: 'Kuzu: Insert and Persist Bob',
			callback: () => {
				this.worker.postMessage({
					type: 'insert',
					cypher: "CREATE (:Person {name: 'Bob', age: 42});"
				});
				// Immediately persist afterward
				setTimeout(() => {
					this.worker.postMessage({ type: 'persist' });
				}, 100); // Give the insert a moment to finish
			}
		});

		this.addCommand({
			id: 'kuzu-init-schema',
			name: 'Kuzu: Ensure Person Table',
			callback: () => {
				this.worker.postMessage({
					type: 'query',
					cypher: 'CREATE NODE TABLE IF NOT EXISTS Person(name STRING, age INT64, PRIMARY KEY(name));'
				});
			}
		});

		this.addCommand({
			id: 'kuzu-sample-query',
			name: 'Kuzu: Query People DB',
			callback: () => {
				this.worker.postMessage({
					type: 'query',
					cypher: 'MATCH (p:Person) RETURN p.name, p.age;'
				});
			}
		});

		this.addCommand({
			id: 'kuzu-fs-list',
			name: 'Kuzu: File System',
			callback: () => {
				this.worker.postMessage({ type: 'fs-list', });
			}
		});

		console.log("Kuzu plugin loaded");
	}

	onunload() {
		// On unload, ask worker to persist data and terminate it
		this.worker.postMessage({ type: 'persist' });
		this.worker.terminate();
		console.log("Kuzu plugin unloaded");
	}
}
