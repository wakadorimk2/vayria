import { publicPagePath } from '../public/paths';
import { WorldCards } from './WorldCards';
import { useSharedWorld } from './useSharedWorld';
export default function WorldParticipantPage(){const id=publicPagePath(location.pathname).split('/')[2];const world=useSharedWorld(id);return <main className="shared-world-participant"><WorldCards world={world}/></main>;}
