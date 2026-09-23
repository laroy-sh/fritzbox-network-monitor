// Small XML reader for TR-064's device descriptions and SOAP responses.
// It deliberately rejects DTDs and external entities.
export function parseXml(xml) {
    if (typeof xml !== 'string' || xml.length > 2_000_000)
        throw new Error('Invalid or oversized XML response');

    const root = {name: '#document', children: [], text: ''};
    const stack = [root];
    let pos = 0;

    while (pos < xml.length) {
        const start = xml.indexOf('<', pos);
        if (start < 0) {
            appendText(stack.at(-1), xml.slice(pos));
            break;
        }
        appendText(stack.at(-1), xml.slice(pos, start));

        if (xml.startsWith('<!--', start)) {
            const end = xml.indexOf('-->', start + 4);
            if (end < 0)
                throw new Error('Unclosed XML comment');
            pos = end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', start)) {
            const end = xml.indexOf(']]>', start + 9);
            if (end < 0)
                throw new Error('Unclosed CDATA');
            stack.at(-1).text += xml.slice(start + 9, end);
            pos = end + 3;
            continue;
        }
        if (xml.startsWith('<?', start)) {
            const end = xml.indexOf('?>', start + 2);
            if (end < 0)
                throw new Error('Unclosed XML instruction');
            pos = end + 2;
            continue;
        }
        if (xml.startsWith('<!', start))
            throw new Error('DTD is not allowed');

        const end = findTagEnd(xml, start + 1);
        const tag = xml.slice(start + 1, end).trim();
        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            if (stack.length < 2 || stack.at(-1).name !== name)
                throw new Error('Mismatched XML closing tag');
            stack.pop();
        } else {
            const selfClosing = tag.endsWith('/');
            const content = selfClosing ? tag.slice(0, -1).trim() : tag;
            const name = /^([^\s/>]+)/.exec(content)?.[1];
            if (!name || !/^[A-Za-z_][\w.:-]*$/.test(name))
                throw new Error('Invalid XML tag');
            const node = {name, children: [], text: ''};
            stack.at(-1).children.push(node);
            if (!selfClosing) {
                if (stack.length > 64)
                    throw new Error('XML is too deeply nested');
                stack.push(node);
            }
        }
        pos = end + 1;
    }
    if (stack.length !== 1 || root.children.length !== 1)
        throw new Error('Incomplete XML response');
    return root.children[0];
}

function findTagEnd(xml, pos) {
    let quote = null;
    for (let i = pos; i < xml.length; i++) {
        const char = xml[i];
        if (quote) {
            if (char === quote)
                quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return i;
        }
    }
    throw new Error('Unclosed XML tag');
}

function appendText(node, text) {
    if (!text)
        return;
    node.text += text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
        (_whole, entity) => {
            if (entity[0] === '#') {
                const value = entity[1].toLowerCase() === 'x'
                    ? Number.parseInt(entity.slice(2), 16)
                    : Number.parseInt(entity.slice(1), 10);
                if (value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
                    throw new Error('Invalid XML character');
                return String.fromCodePoint(value);
            }
            return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[entity];
        });
    if (/&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);)/.test(node.text))
        throw new Error('Unsupported XML entity');
}

export function localName(node) {
    return node.name.split(':').at(-1);
}

export function child(node, name) {
    return node?.children.find(item => localName(item) === name) ?? null;
}

export function children(node, name) {
    return node?.children.filter(item => localName(item) === name) ?? [];
}

export function descendants(node, name) {
    const result = [];
    for (const item of node?.children ?? []) {
        if (localName(item) === name)
            result.push(item);
        result.push(...descendants(item, name));
    }
    return result;
}

export function value(node, name) {
    return child(node, name)?.text.trim() ?? null;
}
