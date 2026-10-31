// 예약 작업은 '활동' 화면의 탭으로 옮겼다 (예전 주소는 그리로)
import { redirect } from '@sveltejs/kit';

export const load = () => {
	redirect(307, '/activity?tab=tasks');
};
