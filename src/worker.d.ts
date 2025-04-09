declare module 'kuzu.worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}