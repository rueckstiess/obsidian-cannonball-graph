/**
 * Base interface for all KuzuDB worker messages.
 */
export interface KuzuWorkerMessage {
  /** Unique identifier to correlate requests and responses */
  id: string;
}

/**
 * Base interface for all request messages.
 */
export interface KuzuBaseRequest extends KuzuWorkerMessage {
  /** Type of the request */
  type: string;
}

/**
 * Base interface for all success response messages.
 */
export interface KuzuBaseSuccess extends KuzuWorkerMessage {
  /** Type of the success response */
  type: string;
}

/**
 * Request to initialize the KuzuDB database.
 */
export interface KuzuInitRequest extends KuzuBaseRequest {
  type: 'init';
  /** Optional persisted database data to restore */
  dbData?: ArrayBuffer;
}

/**
 * Request to execute a read-only Cypher query.
 */
export interface KuzuQueryRequest extends KuzuBaseRequest {
  type: 'query';
  /** The Cypher query to execute */
  cypher: string;
}

/**
 * Request to execute a Cypher statement that modifies the database.
 */
export interface KuzuInsertRequest extends KuzuBaseRequest {
  type: 'insert';
  /** The Cypher statement to execute */
  cypher: string;
}

/**
 * Request to persist the database to storage.
 */
export interface KuzuPersistRequest extends KuzuBaseRequest {
  type: 'persist';
}

/**
 * Successful response to an initialization request.
 */
export interface KuzuInitSuccess extends KuzuBaseSuccess {
  type: 'init-success';
}

/**
 * Successful response to a query request.
 */
export interface KuzuQuerySuccess extends KuzuBaseSuccess {
  type: 'query-success';
  /** The query results as a JSON string */
  data: string;
}

/**
 * Successful response to an insert request.
 */
export interface KuzuInsertSuccess extends KuzuBaseSuccess {
  type: 'insert-success';
}

/**
 * Successful response to a persist request.
 */
export interface KuzuPersistSuccess extends KuzuBaseSuccess {
  type: 'persist-success';
  /** The serialized database files */
  files: Record<string, string>;
}

/**
 * Error response from any request.
 */
export interface KuzuErrorResponse extends KuzuWorkerMessage {
  type: 'error';
  /** Error message */
  error: string;
  /** Original request type that caused the error */
  requestType: string;
}

/**
 * Union type of all possible request messages.
 */
export type KuzuRequest =
  | KuzuInitRequest
  | KuzuQueryRequest
  | KuzuInsertRequest
  | KuzuPersistRequest;

/**
 * Union type of all possible success response messages.
 */
export type KuzuSuccessResponse =
  | KuzuInitSuccess
  | KuzuQuerySuccess
  | KuzuInsertSuccess
  | KuzuPersistSuccess;

/**
 * Union type of all possible response messages.
 */
export type KuzuResponse =
  | KuzuSuccessResponse
  | KuzuErrorResponse;