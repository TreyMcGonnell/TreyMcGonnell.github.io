import '../styles/base.css';
import '../styles/home.css';
import { startHome } from './app';
import { enableFonts } from '../fonts';

enableFonts();
document.body.classList.add('page-home'); // also set in the HTML; kept here for builds whose page wrapper is generated

startHome();
