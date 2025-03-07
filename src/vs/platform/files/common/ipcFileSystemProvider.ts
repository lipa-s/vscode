/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from 'vs/base/common/buffer';
import { CancellationToken } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { canceled } from 'vs/base/common/errors';
import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { newWriteableStream, ReadableStreamEventPayload, ReadableStreamEvents } from 'vs/base/common/stream';
import { URI, UriComponents } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { IChannel } from 'vs/base/parts/ipc/common/ipc';
import { createFileSystemProviderError, FileChangeType, FileDeleteOptions, FileOpenOptions, FileOverwriteOptions, FileReadStreamOptions, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, FileWriteOptions, IFileChange, IFileSystemProviderWithFileFolderCopyCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithOpenReadWriteCloseCapability, IStat, IWatchOptions } from 'vs/platform/files/common/files';

/**
 * An implementation of a file system provider that is backed by a `IChannel`
 * and thus implemented via IPC on a different process.
 */
export abstract class IPCFileSystemProvider extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	IFileSystemProviderWithFileReadStreamCapability,
	IFileSystemProviderWithFileFolderCopyCapability {

	constructor(private readonly channel: IChannel) {
		super();

		this.registerFileChangeListeners();
	}

	//#region File Capabilities

	private readonly _onDidChangeCapabilities = this._register(new Emitter<void>());
	readonly onDidChangeCapabilities = this._onDidChangeCapabilities.event;

	private _capabilities = FileSystemProviderCapabilities.FileReadWrite
		| FileSystemProviderCapabilities.FileOpenReadWriteClose
		| FileSystemProviderCapabilities.FileReadStream
		| FileSystemProviderCapabilities.FileFolderCopy
		| FileSystemProviderCapabilities.FileWriteUnlock;
	get capabilities(): FileSystemProviderCapabilities { return this._capabilities; }

	protected setCaseSensitive(isCaseSensitive: boolean) {
		if (isCaseSensitive) {
			this._capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
		} else {
			this._capabilities &= ~FileSystemProviderCapabilities.PathCaseSensitive;
		}

		this._onDidChangeCapabilities.fire();
	}

	//#endregion

	//#region File Metadata Resolving

	stat(resource: URI): Promise<IStat> {
		return this.channel.call('stat', [resource]);
	}

	readdir(resource: URI): Promise<[string, FileType][]> {
		return this.channel.call('readdir', [resource]);
	}

	//#endregion

	//#region File Reading/Writing

	async readFile(resource: URI): Promise<Uint8Array> {
		const { buffer } = await this.channel.call('readFile', [resource]) as VSBuffer;

		return buffer;
	}

	readFileStream(resource: URI, opts: FileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		const stream = newWriteableStream<Uint8Array>(data => VSBuffer.concat(data.map(data => VSBuffer.wrap(data))).buffer);

		// Reading as file stream goes through an event to the remote side
		const listener = this.channel.listen<ReadableStreamEventPayload<VSBuffer>>('readFileStream', [resource, opts])(dataOrErrorOrEnd => {

			// data
			if (dataOrErrorOrEnd instanceof VSBuffer) {
				stream.write(dataOrErrorOrEnd.buffer);
			}

			// end or error
			else {
				if (dataOrErrorOrEnd === 'end') {
					stream.end();
				} else {

					// Since we receive data through a IPC channel, it is likely
					// that the error was not serialized, or only partially. To
					// ensure our API use is correct, we convert the data to an
					// error here to forward it properly.
					let error = dataOrErrorOrEnd;
					if (!(error instanceof Error)) {
						error = createFileSystemProviderError(toErrorMessage(error), FileSystemProviderErrorCode.Unknown);
					}

					stream.error(error);
					stream.end();
				}

				// Signal to the remote side that we no longer listen
				listener.dispose();
			}
		});

		// Support cancellation
		token.onCancellationRequested(() => {

			// Ensure to end the stream properly with an error
			// to indicate the cancellation.
			stream.error(canceled());
			stream.end();

			// Ensure to dispose the listener upon cancellation. This will
			// bubble through the remote side as event and allows to stop
			// reading the file.
			listener.dispose();
		});

		return stream;
	}

	writeFile(resource: URI, content: Uint8Array, opts: FileWriteOptions): Promise<void> {
		return this.channel.call('writeFile', [resource, VSBuffer.wrap(content), opts]);
	}

	open(resource: URI, opts: FileOpenOptions): Promise<number> {
		return this.channel.call('open', [resource, opts]);
	}

	close(fd: number): Promise<void> {
		return this.channel.call('close', [fd]);
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const [bytes, bytesRead]: [VSBuffer, number] = await this.channel.call('read', [fd, pos, length]);

		// copy back the data that was written into the buffer on the remote
		// side. we need to do this because buffers are not referenced by
		// pointer, but only by value and as such cannot be directly written
		// to from the other process.
		data.set(bytes.buffer.slice(0, bytesRead), offset);

		return bytesRead;
	}

	write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		return this.channel.call('write', [fd, pos, VSBuffer.wrap(data), offset, length]);
	}

	//#endregion

	//#region Move/Copy/Delete/Create Folder

	mkdir(resource: URI): Promise<void> {
		return this.channel.call('mkdir', [resource]);
	}

	delete(resource: URI, opts: FileDeleteOptions): Promise<void> {
		return this.channel.call('delete', [resource, opts]);
	}

	rename(resource: URI, target: URI, opts: FileOverwriteOptions): Promise<void> {
		return this.channel.call('rename', [resource, target, opts]);
	}

	copy(resource: URI, target: URI, opts: FileOverwriteOptions): Promise<void> {
		return this.channel.call('copy', [resource, target, opts]);
	}

	//#endregion

	//#region File Watching

	private readonly _onDidChange = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChange.event;

	private readonly _onDidErrorOccur = this._register(new Emitter<string>());
	readonly onDidErrorOccur = this._onDidErrorOccur.event;

	// The contract for file watching via remote is to identify us
	// via a unique but readonly session ID. Since the remote is
	// managing potentially many watchers from different clients,
	// this helps the server to properly partition events to the right
	// clients.
	private readonly sessionId = generateUuid();

	private registerFileChangeListeners(): void {

		// The contract for file changes is that there is one listener
		// for both events and errors from the watcher. So we need to
		// unwrap the event from the remote and emit through the proper
		// emitter.
		this._register(this.channel.listen<{ resource: UriComponents; type: FileChangeType; }[] | string>('filechange', [this.sessionId])(eventsOrError => {
			if (Array.isArray(eventsOrError)) {
				const events = eventsOrError;
				this._onDidChange.fire(events.map(event => ({ resource: URI.revive(event.resource), type: event.type })));
			} else {
				const error = eventsOrError;
				this._onDidErrorOccur.fire(error);
			}
		}));
	}

	watch(resource: URI, opts: IWatchOptions): IDisposable {

		// Generate a request UUID to correlate the watcher
		// back to us when we ask to dispose the watcher later.
		const req = generateUuid();

		this.channel.call('watch', [this.sessionId, req, resource, opts]);

		return toDisposable(() => this.channel.call('unwatch', [this.sessionId, req]));
	}

	//#endregion
}
