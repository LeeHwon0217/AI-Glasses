"""교안 PDF에서 글자를 뽑아 앱이 쓸 수 있는 파일로 만든다.

사용법:  python tools/make_materials.py "PDF가 있는 폴더"
필요:    pip install pymupdf cryptography

만드는 것:
  교안/교안.json      글자 원문 (저작권 자료라 저장소에 올리지 않는다. .gitignore 참고)
  교안/key.txt        암호화 열쇠 (올리지 않는다. 있으면 다시 써서 설정 링크가 그대로 유지된다)
  교안/설정링크.txt   폰에서 한 번 열면 교안이 받아지는 링크 (열쇠가 들어 있으니 올리지 않는다)
  materials.enc       교안.json을 압축하고 AES-256-GCM으로 암호화한 파일 (이것만 저장소에 올린다)
"""
import base64
import gzip
import io
import json
import os
import sys

import fitz  # PyMuPDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SITE = 'https://leehwon0217.github.io/AI-Glasses/'
SUBJECTS = ['언어교수이론', '한국어표현교육론', '한국어 교육과정론', '한국어 교재론',
            '한국어 어휘교육론', '외국어 습득론', '한국민속학']


def extract(path):
    pages = []
    for i, page in enumerate(fitz.open(path)):
        lines = [l.strip() for l in page.get_text().splitlines()]
        text = '\n'.join(l for l in lines if l)
        if len(text) >= 20:  # 표지·그림만 있는 쪽은 건너뛴다
            pages.append('[%d쪽]\n%s' % (i + 1, text))
    return '\n\n'.join(pages)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    src = sys.argv[1] if len(sys.argv) > 1 else '.'
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, '교안')
    os.makedirs(out_dir, exist_ok=True)

    subjects = []
    for name in SUBJECTS:
        path = os.path.join(src, name + '.pdf')
        if not os.path.exists(path):
            print('없음:', path)
            continue
        text = extract(path)
        subjects.append({'name': name, 'text': text})
        print('%s: %d자' % (name, len(text)))
    data = json.dumps({'subjects': subjects}, ensure_ascii=False).encode('utf-8')
    with io.open(os.path.join(out_dir, '교안.json'), 'wb') as f:
        f.write(data)

    key_path = os.path.join(out_dir, 'key.txt')
    if os.path.exists(key_path):
        key_text = io.open(key_path, encoding='ascii').read().strip()
    else:
        key_text = base64.urlsafe_b64encode(os.urandom(32)).decode('ascii').rstrip('=')
        io.open(key_path, 'w', encoding='ascii').write(key_text)
    key = base64.urlsafe_b64decode(key_text + '=' * (-len(key_text) % 4))

    iv = os.urandom(12)
    enc = iv + AESGCM(key).encrypt(iv, gzip.compress(data, mtime=0), None)
    with io.open(os.path.join(root, 'materials.enc'), 'wb') as f:
        f.write(enc)
    io.open(os.path.join(out_dir, '설정링크.txt'), 'w', encoding='utf-8').write(SITE + '#mat=' + key_text + '\n')

    print('materials.enc: %.2f MB (저장소에 올리는 파일)' % (len(enc) / 1e6))
    print('설정 링크: 교안/설정링크.txt (폰에서 한 번 열기)')


if __name__ == '__main__':
    main()
