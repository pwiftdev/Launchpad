import { socialApi } from '@/server/socialApi';
export const config = { api: { bodyParser: { sizeLimit: '5kb' } } };
export default socialApi('profile');
