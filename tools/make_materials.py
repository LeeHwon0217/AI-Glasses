"""교안 PDF에서 글자를 뽑아 앱이 불러올 수 있는 '교안.json' 한 파일로 만든다.

사용법:  python tools/make_materials.py "PDF가 있는 폴더"
결과물:  교안/교안.json  (저작권이 있는 자료라 저장소에는 올리지 않는다. .gitignore 참고)
필요:    pip install pymupdf
"""
import io
import json
import os
import sys

import fitz  # PyMuPDF

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
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '교안')
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
    out = os.path.join(out_dir, '교안.json')
    with io.open(out, 'w', encoding='utf-8') as f:
        json.dump({'subjects': subjects}, f, ensure_ascii=False)
    print('저장:', out, '(%.1f MB)' % (os.path.getsize(out) / 1e6))


if __name__ == '__main__':
    main()
