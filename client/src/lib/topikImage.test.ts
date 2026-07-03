/**
 * splitImageItem — the prompt split for image-dependent TOPIK items: curated
 * imageText precedence, bracketed-segment extraction (trailing, whole-prompt,
 * multiple), and the no-description fallback.
 */
import { describe, it, expect } from 'vitest';
import { splitImageItem } from './topikImage';

describe('splitImageItem', () => {
  it('prefers curated imageText and leaves the prompt intact', () => {
    const out = splitImageItem('여자: 어서 오세요. [그림]', '카페에서 주문하는 그림');
    expect(out.description).toBe('카페에서 주문하는 그림');
    // Curated text wins — the prompt (brackets included) stays as the body.
    expect(out.body).toBe('여자: 어서 오세요. [그림]');
  });

  it('extracts a trailing bracketed description from a transcript prompt', () => {
    const prompt =
      '여자: 어디가 아파서 오셨어요?\n남자: 배가 아파서 왔는데요.\n[알맞은 그림 고르기: ①진료실 ②접수처 ③병실 ④대기실]';
    const out = splitImageItem(prompt);
    expect(out.description).toBe(
      '알맞은 그림 고르기: ①진료실 ②접수처 ③병실 ④대기실',
    );
    expect(out.body).toBe('여자: 어디가 아파서 오셨어요?\n남자: 배가 아파서 왔는데요.');
  });

  it('handles a whole-prompt description (reading banner items) → empty body', () => {
    const out = splitImageItem('[공익 배너: 푸른 숲, 맑은 강 / 다 함께 지켜 가요!]');
    expect(out.description).toBe('공익 배너: 푸른 숲, 맑은 강 / 다 함께 지켜 가요!');
    expect(out.body).toBe('');
  });

  it('joins multiple bracketed segments in order', () => {
    const out = splitImageItem('본문 [그림 1: 지도] 중간 [그림 2: 표]');
    expect(out.description).toBe('그림 1: 지도\n그림 2: 표');
    expect(out.body).toBe('본문  중간');
  });

  it('returns a null description when no brackets and no imageText exist', () => {
    const out = splitImageItem('학생회에서는 왜 이 글을 썼는지 맞는 것을 고르십시오.');
    expect(out.description).toBeNull();
    expect(out.body).toBe('학생회에서는 왜 이 글을 썼는지 맞는 것을 고르십시오.');
  });

  it('ignores empty bracket pairs and blank-only segments', () => {
    const out = splitImageItem('본문 [] [  ] 끝');
    expect(out.description).toBeNull();
    expect(out.body).toBe('본문 [] [  ] 끝');
  });

  it('is total on degenerate input', () => {
    expect(splitImageItem('')).toEqual({ body: '', description: null });
    expect(splitImageItem('   ')).toEqual({ body: '', description: null });
  });
});
