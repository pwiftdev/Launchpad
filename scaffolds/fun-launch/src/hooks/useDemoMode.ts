import { DEMO_ENABLED } from '@/lib/demo';
import { useLocalSetting } from './useLocalSetting';

export function useDemoMode() {
  const [visible, setVisible] = useLocalSetting('rinsed.showDemoLaunches', true);
  return { available: DEMO_ENABLED, visible: DEMO_ENABLED && visible, setVisible };
}
