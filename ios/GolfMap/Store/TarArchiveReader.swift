import Foundation

/// One extracted regular-file entry from a tar archive.
public struct TarEntry: Sendable, Equatable {
    /// Sanitized, forward-slash separated relative path (e.g. `19/12345/6789.webp`).
    public let name: String
    public let data: Data

    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }
}

public enum TarArchiveError: Error, Equatable {
    /// The stream ended in the middle of a header or file body.
    case truncated
    /// A header field (size octal) could not be parsed.
    case invalidHeader
    /// An entry name is unsafe to write to disk: empty, absolute, or contains
    /// a `..` component. The archive arrives over the network, so a hostile
    /// name must never escape the staging directory.
    case unsafeEntryName(String)
}

/// Minimal sequential reader for uncompressed POSIX **ustar** archives — only
/// what the tile-archive server contract emits: regular-file entries
/// (typeflag `'0'`/`'\0'`), octal sizes, two-zero-block termination. No
/// pax/gnu long-name extensions. Malformed input throws; entry names are
/// sanitized before they reach the caller.
public enum TarArchiveReader {
    private static let blockSize = 512

    /// Parses `data`, invoking `handler` once per regular-file entry, in order.
    /// Non-regular entries (directories, links) are skipped. Throws
    /// `TarArchiveError` on malformed input or an unsafe entry name.
    public static func read(_ data: Data, handler: (TarEntry) throws -> Void) throws {
        let base = data.startIndex
        let count = data.count
        var offset = 0

        while true {
            // A clean end: no bytes left (we tolerate archives that omit the
            // trailing zero blocks) or the next block is all zeros.
            if offset == count { return }
            guard offset + blockSize <= count else { throw TarArchiveError.truncated }

            let headerStart = base + offset
            let header = [UInt8](data[headerStart..<(headerStart + blockSize)])
            if header.allSatisfy({ $0 == 0 }) {
                return // first zero block terminates the archive
            }
            offset += blockSize

            let rawName = entryName(from: header)
            let size = try entrySize(from: header)
            let typeflag = header[156]

            let paddedSize = size == 0 ? 0 : ((size + blockSize - 1) / blockSize) * blockSize
            guard offset + paddedSize <= count else { throw TarArchiveError.truncated }

            // typeflag '0' (regular) or '\0' (legacy regular). Everything else
            // (directory '5', links, pax/gnu 'x'/'g'/'L'/'K', …) is skipped.
            if typeflag == UInt8(ascii: "0") || typeflag == 0 {
                let name = try sanitize(name: rawName)
                let dataStart = base + offset
                let fileData = data.subdata(in: dataStart..<(dataStart + size))
                try handler(TarEntry(name: name, data: fileData))
            }

            offset += paddedSize
        }
    }

    // MARK: - Header field parsing

    private static func entryName(from header: [UInt8]) -> String {
        let name = cString(header, start: 0, maxLength: 100)
        let prefix = cString(header, start: 345, maxLength: 155)
        return prefix.isEmpty ? name : prefix + "/" + name
    }

    private static func entrySize(from header: [UInt8]) throws -> Int {
        let field = cString(header, start: 124, maxLength: 12)
            .trimmingCharacters(in: .whitespaces)
        if field.isEmpty { return 0 }
        guard let value = Int(field, radix: 8), value >= 0 else {
            throw TarArchiveError.invalidHeader
        }
        return value
    }

    /// Reads a NUL-terminated ASCII field.
    private static func cString(_ header: [UInt8], start: Int, maxLength: Int) -> String {
        let end = min(start + maxLength, header.count)
        var bytes = Array(header[start..<end])
        if let nul = bytes.firstIndex(of: 0) { bytes = Array(bytes[..<nul]) }
        return String(decoding: bytes, as: UTF8.self)
    }

    // MARK: - Name safety

    private static func sanitize(name: String) throws -> String {
        guard !name.isEmpty else { throw TarArchiveError.unsafeEntryName(name) }
        guard !name.hasPrefix("/") else { throw TarArchiveError.unsafeEntryName(name) }
        for component in name.split(separator: "/", omittingEmptySubsequences: false)
        where component == ".." {
            throw TarArchiveError.unsafeEntryName(name)
        }
        return name
    }
}
