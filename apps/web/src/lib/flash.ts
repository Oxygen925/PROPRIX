// 목록의 그 항목으로 가서 잠깐 강조한다. .flash 의 모양은 항목을 그리는 컴포넌트가 정한다
export function flashTo(el: Element) {
	el.scrollIntoView({ block: 'center' });
	el.classList.add('flash');
	setTimeout(() => el.classList.remove('flash'), 2600);
}
