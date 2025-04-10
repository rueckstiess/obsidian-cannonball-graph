declare module 'kuzu-wasm/sync' {
  const kuzu: any;
  export = kuzu;
}

declare module 'kuzu.worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}